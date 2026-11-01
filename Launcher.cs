using System;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Program
{
    const string URL = "http://127.0.0.1:8787";

    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [STAThread]
    static int Main()
    {
        string root = Path.GetDirectoryName(Application.ExecutablePath);
        string logDir = Path.Combine(root, "logs");
        try { Directory.CreateDirectory(logDir); } catch { }

        // 窗口开着 + 服务在跑 = 只是重复启动，把窗口叫到前面就行
        Process existing = FindAppWindow();
        if (existing != null && IsUp(400))
        {
            Focus(existing);
            return 0;
        }

        string node = FindNode(root);
        if (node == null)
        {
            MessageBox.Show(
                "找不到 node.exe。\r\n\r\n把 node.exe 放进 runtime\\ 目录，或先安装 Node.js。",
                "提示词翻译台", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        Process nodeProc = null;
        if (!IsUp(400))
        {
            nodeProc = StartNode(node, root, Path.Combine(logDir, "desktop.log"));
            if (nodeProc == null)
            {
                MessageBox.Show("服务启动失败，看 logs\\desktop.log", "提示词翻译台",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            if (!WaitUp(150000))
            {
                MessageBox.Show("服务启动超时，看 logs\\desktop.log", "提示词翻译台",
                    MessageBoxButtons.OK, MessageBoxIcon.Error);
                KillTree(nodeProc.Id);
                return 1;
            }
        }

        // 开窗口：最多试三次（profile 可能还在解锁）
        if (existing == null)
        {
            for (int attempt = 0; attempt < 3; attempt++)
            {
                Process p = OpenWindow();
                if (p == null) break;                       // 压根没有 Edge
                for (int i = 0; i < 12; i++)
                {
                    Thread.Sleep(600);
                    if (FindAppWindow() != null) break;
                }
                if (FindAppWindow() != null) break;
                Thread.Sleep(900);
            }

            if (FindAppWindow() == null)
            {
                try { Process.Start(new ProcessStartInfo(URL) { UseShellExecute = true }); } catch { }
                MessageBox.Show("窗口没能打开，已改用默认浏览器。\r\n服务还在后台跑，用完请双击「停止.bat」。",
                    "提示词翻译台", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return 0;
            }
        }
        else
        {
            // 窗口早就在，只是服务掉了：刚把它拉起来，把窗口叫回来，页面会自己恢复
            Focus(existing);
        }

        // 以「窗口还在不在」为准：连续 3 次（约 6 秒）消失就算用户关了
        int miss = 0;
        while (true)
        {
            Thread.Sleep(2000);
            if (FindAppWindow() != null) { miss = 0; continue; }
            if (++miss >= 3) break;
        }

        if (nodeProc != null && !nodeProc.HasExited)
        {
            Shutdown();
            if (!nodeProc.WaitForExit(5000)) KillTree(nodeProc.Id);
        }
        return 0;
    }

    // 只认「用专用 profile 起的那个 Edge 窗口」，避免误认用户自己浏览器里的同名标签页
    static Process FindAppWindow()
    {
        try
        {
            using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='msedge.exe'"))
            using (ManagementObjectCollection results = searcher.Get())
            {
                foreach (ManagementBaseObject mo in results)
                {
                    string cmd = (mo["CommandLine"] as string) ?? "";
                    if (cmd.IndexOf("llama-translate", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    if (cmd.IndexOf("edge-profile", StringComparison.OrdinalIgnoreCase) < 0) continue;
                    int pid;
                    try { pid = Convert.ToInt32(mo["ProcessId"]); } catch { continue; }
                    try
                    {
                        Process p = Process.GetProcessById(pid);
                        if (p.MainWindowHandle != IntPtr.Zero) return p;
                    }
                    catch { }
                }
            }
        }
        catch { }
        return null;
    }

    static void Focus(Process p)
    {
        try
        {
            ShowWindow(p.MainWindowHandle, 9);   // SW_RESTORE
            SetForegroundWindow(p.MainWindowHandle);
        }
        catch { }
    }

    static string FindNode(string root)
    {
        string local = Path.Combine(root, "runtime", "node.exe");
        if (File.Exists(local)) return local;

        string[] cand = {
            @"C:\Program Files\nodejs\node.exe",
            @"C:\Program Files (x86)\nodejs\node.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe")
        };
        foreach (string c in cand) if (File.Exists(c)) return c;

        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("where", "node.exe");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            using (Process p = Process.Start(psi))
            {
                string outp = p.StandardOutput.ReadToEnd();
                p.WaitForExit(2000);
                foreach (string line in outp.Split('\n'))
                {
                    string t = line.Trim();
                    if (t.Length > 0 && File.Exists(t)) return t;
                }
            }
        }
        catch { }
        return null;
    }

    static Process StartNode(string node, string root, string logPath)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(node, "server.js");
            psi.WorkingDirectory = root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = new UTF8Encoding(false);
            psi.StandardErrorEncoding = new UTF8Encoding(false);
            psi.EnvironmentVariables["NO_BROWSER"] = "1";   // 桌面版自己开窗口，别再弹浏览器

            Process p = Process.Start(psi);
            StreamWriter sw = new StreamWriter(logPath, true, new UTF8Encoding(true));
            sw.AutoFlush = true;
            lock (sw) { sw.WriteLine("=== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " 启动 pid=" + p.Id); }

            p.OutputDataReceived += delegate (object s, DataReceivedEventArgs e)
            {
                if (e.Data == null) return;
                lock (sw) { sw.WriteLine(e.Data); }
            };
            p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e)
            {
                if (e.Data == null) return;
                lock (sw) { sw.WriteLine(e.Data); }
            };
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            return p;
        }
        catch (Exception ex)
        {
            try { File.AppendAllText(logPath, "启动失败: " + ex.Message + Environment.NewLine); } catch { }
            return null;
        }
    }

    static Process OpenWindow()
    {
        string edge = FindEdge();
        if (edge == null) return null;

        string profile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "llama-translate", "edge-profile");
        try { Directory.CreateDirectory(profile); } catch { }

        // 上次被强杀会留下 lockfile，留着会让新实例直接退出
        try
        {
            string lockFile = Path.Combine(profile, "lockfile");
            if (File.Exists(lockFile) && FindAppWindow() == null) File.Delete(lockFile);
        }
        catch { }

        string args = "--app=" + URL
            + " --user-data-dir=\"" + profile + "\""
            + " --window-size=1460,940"
            + " --no-first-run --no-default-browser-check"
            + " --disable-background-mode --disable-sync";

        ProcessStartInfo psi = new ProcessStartInfo(edge, args);
        psi.UseShellExecute = false;
        return Process.Start(psi);
    }

    static string FindEdge()
    {
        string[] cand = {
            @"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            @"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"Microsoft\Edge\Application\msedge.exe")
        };
        foreach (string c in cand) if (File.Exists(c)) return c;
        return null;
    }

    static bool IsUp(int timeoutMs)
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(URL + "/api/state");
            req.Timeout = timeoutMs;
            req.Proxy = null;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
            {
                return (int)resp.StatusCode == 200;
            }
        }
        catch { return false; }
    }

    static bool WaitUp(int timeoutMs)
    {
        int t0 = Environment.TickCount;
        while (Environment.TickCount - t0 < timeoutMs)
        {
            if (IsUp(700)) return true;
            Thread.Sleep(400);
        }
        return false;
    }

    static void Shutdown()
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(URL + "/api/shutdown");
            req.Method = "POST";
            req.ContentLength = 0;
            req.Timeout = 2500;
            req.Proxy = null;
            using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse()) { }
        }
        catch { }
    }

    static void KillTree(int pid)
    {
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo("taskkill", "/PID " + pid + " /T /F");
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            using (Process p = Process.Start(psi)) { p.WaitForExit(5000); }
        }
        catch { }
    }
}
