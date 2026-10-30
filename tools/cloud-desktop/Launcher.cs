using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

// This executable only starts the bundled runtime. Downloading and verification
// remain in the signed-update protocol; no WSH, VBS or shell command is involved.
internal static class JinbaoLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string runtime = Path.Combine(root, "runtime", "node.exe");
        string entry = Path.Combine(root, "tools", "cloud-desktop", "entry.mjs");
        try
        {
            if (!File.Exists(runtime) || !File.Exists(entry))
                throw new FileNotFoundException("请先将金宝压缩包完整解压，再启动金宝。");
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = runtime;
            start.Arguments = "\"" + entry + "\" --collect --coach";
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--headless") start.Arguments += " --headless";
                else if (args[i] == "--team-rooms") start.Arguments += " --team-rooms";
                else if (args[i] == "--team-byok-host") start.Arguments += " --team-byok-host";
                else if (args[i] == "--state" && i + 1 < args.Length)
                {
                    string state = Path.GetFullPath(args[++i]);
                    if (state.IndexOf('"') >= 0 || state.IndexOf('\n') >= 0 || state.IndexOf('\r') >= 0)
                        throw new ArgumentException("状态目录格式不正确。");
                    start.Arguments += " --state \"" + state + (state.EndsWith("\\") ? "\\" : "") + "\"";
                }
                else throw new ArgumentException("启动参数不受支持。");
            }
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            using (Process child = Process.Start(start))
            {
                if (child == null) throw new InvalidOperationException("无法启动金宝运行时。");
                // Report an immediate launch failure instead of flashing away.
                if (child.WaitForExit(1200) && child.ExitCode != 0)
                    throw new InvalidOperationException("金宝启动失败，请检查解压是否完整以及安全软件的拦截记录。");
            }
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "金宝启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
