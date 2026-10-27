using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class Launcher
{
    [STAThread]
    private static int Main()
    {
        try
        {
            string folder = AppDomain.CurrentDomain.BaseDirectory;
            string sourceRoot = Path.Combine(folder, "cmd-toolbox");
            string electron = Path.Combine(sourceRoot, "node_modules", "electron", "dist", "electron.exe");
            string uiFile = Path.Combine(sourceRoot, "dist", "index.html");
            string packed = Path.Combine(sourceRoot, "release", "win-unpacked", "CmdToolbox.exe");

            if (File.Exists(electron) && File.Exists(uiFile))
            {
                Start(electron, ".", sourceRoot);
                return 0;
            }

            if (File.Exists(packed))
            {
                Start(packed, "", Path.GetDirectoryName(packed));
                return 0;
            }

            if (File.Exists(electron))
            {
                Alert("还没有生成界面文件。请先在 cmd-toolbox 文件夹里运行 npm run build，再双击这个程序。");
                return 1;
            }

            Alert("找不到 Cmd Toolbox。请把这个程序和 cmd-toolbox 源码文件夹放在同一目录。");
            return 1;
        }
        catch (Exception error)
        {
            Alert("启动失败：" + error.Message);
            return 1;
        }
    }

    private static void Start(string fileName, string arguments, string workingDirectory)
    {
        ProcessStartInfo info = new ProcessStartInfo();
        info.FileName = fileName;
        info.Arguments = arguments ?? "";
        info.WorkingDirectory = workingDirectory ?? Path.GetDirectoryName(fileName);
        info.UseShellExecute = false;
        Process.Start(info);
    }

    private static void Alert(string message)
    {
        MessageBox.Show(message, "Cmd Toolbox", MessageBoxButtons.OK, MessageBoxIcon.Information);
    }
}
