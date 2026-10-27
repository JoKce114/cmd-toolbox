using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class ConsoleMouseReader
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct KEY_EVENT_RECORD
    {
        public int bKeyDown;
        public ushort wRepeatCount;
        public ushort wVirtualKeyCode;
        public ushort wVirtualScanCode;
        public char UnicodeChar;
        public uint dwControlKeyState;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct COORD
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSE_EVENT_RECORD
    {
        public COORD dwMousePosition;
        public uint dwButtonState;
        public uint dwControlKeyState;
        public uint dwEventFlags;
    }

    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    public struct INPUT_RECORD
    {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
        [FieldOffset(4)] public MOUSE_EVENT_RECORD MouseEvent;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int which);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetConsoleMode(IntPtr h, out uint mode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleMode(IntPtr h, uint mode);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool ReadConsoleInputW(IntPtr h, [Out] INPUT_RECORD[] recs, uint len, out uint read);

    public static string Listen(int seconds, string logPath)
    {
        const int STD_INPUT_HANDLE = -10;
        const uint ENABLE_MOUSE_INPUT = 0x0010;
        const uint ENABLE_EXTENDED_FLAGS = 0x0080;
        const uint ENABLE_QUICK_EDIT_MODE = 0x0040;

        IntPtr input = GetStdHandle(STD_INPUT_HANDLE);
        uint mode;
        bool got = GetConsoleMode(input, out mode);
        uint wanted = (mode | ENABLE_MOUSE_INPUT | ENABLE_EXTENDED_FLAGS) & ~ENABLE_QUICK_EDIT_MODE;
        bool set = SetConsoleMode(input, wanted);

        File.WriteAllText(logPath, "mode got=" + got + " old=" + mode + " set=" + set + " wanted=" + wanted + " err=" + Marshal.GetLastWin32Error() + Environment.NewLine, Encoding.UTF8);

        INPUT_RECORD[] buffer = new INPUT_RECORD[16];
        DateTime deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < deadline)
        {
            uint read;
            if (!ReadConsoleInputW(input, buffer, 16, out read))
            {
                File.AppendAllText(logPath, "read failed err=" + Marshal.GetLastWin32Error() + Environment.NewLine, Encoding.UTF8);
                break;
            }
            for (int i = 0; i < read; i++)
            {
                string line;
                if (buffer[i].EventType == 2)
                {
                    long delta = (long)(int)buffer[i].MouseEvent.dwButtonState >> 16;
                    line = "MOUSE x=" + buffer[i].MouseEvent.dwMousePosition.X +
                           " y=" + buffer[i].MouseEvent.dwMousePosition.Y +
                           " delta=" + delta +
                           " flags=" + buffer[i].MouseEvent.dwEventFlags +
                           " state=0x" + buffer[i].MouseEvent.dwButtonState.ToString("X8");
                }
                else
                {
                    line = "EVENT type=" + buffer[i].EventType;
                }
                File.AppendAllText(logPath, line + Environment.NewLine, Encoding.UTF8);
            }
        }
        File.AppendAllText(logPath, "done mode=" + set + Environment.NewLine, Encoding.UTF8);
        return "done";
    }
}
