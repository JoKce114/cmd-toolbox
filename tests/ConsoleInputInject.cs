using System;
using System.Runtime.InteropServices;

public static class ConsoleInputInject
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
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AllocConsole();

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] recs, uint len, out uint written);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr h);

    public static IntPtr OpenCurrentConin()
    {
        return CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
    }

    public static string Attach(uint pid)
    {
        FreeConsole();
        bool ok = AttachConsole(pid);
        return "attach=" + ok + " err=" + Marshal.GetLastWin32Error();
    }

    public static string FreshConsole()
    {
        FreeConsole();
        bool ok = AllocConsole();
        return "fresh=" + ok + " err=" + Marshal.GetLastWin32Error();
    }

    public static void Detach()
    {
        FreeConsole();
    }

    public static void Close(IntPtr h)
    {
        CloseHandle(h);
    }

    public static string InjectKey(IntPtr h, ushort vk, ushort scan, char ch, uint ctrl)
    {
        INPUT_RECORD down = new INPUT_RECORD();
        down.EventType = 1;
        down.KeyEvent.bKeyDown = 1;
        down.KeyEvent.wRepeatCount = 1;
        down.KeyEvent.wVirtualKeyCode = vk;
        down.KeyEvent.wVirtualScanCode = scan;
        down.KeyEvent.UnicodeChar = ch;
        down.KeyEvent.dwControlKeyState = ctrl;

        INPUT_RECORD up = down;
        up.KeyEvent.bKeyDown = 0;

        uint n;
        bool ok1 = WriteConsoleInputW(h, new INPUT_RECORD[] { down }, 1, out n);
        int e1 = Marshal.GetLastWin32Error();
        bool ok2 = WriteConsoleInputW(h, new INPUT_RECORD[] { up }, 1, out n);
        int e2 = Marshal.GetLastWin32Error();
        return "key vk=" + vk + " ch=" + (int)ch + " ctrl=" + ctrl + " down=" + ok1 + "/" + e1 + " up=" + ok2 + "/" + e2;
    }

    public static string InjectWheel(IntPtr h, short x, short y, int delta)
    {
        INPUT_RECORD rec = new INPUT_RECORD();
        rec.EventType = 2;
        rec.MouseEvent.dwMousePosition.X = x;
        rec.MouseEvent.dwMousePosition.Y = y;
        rec.MouseEvent.dwButtonState = (uint)(delta << 16);
        rec.MouseEvent.dwControlKeyState = 0;
        rec.MouseEvent.dwEventFlags = 4;

        uint n;
        bool ok = WriteConsoleInputW(h, new INPUT_RECORD[] { rec }, 1, out n);
        return "wheel delta=" + delta + " ok=" + ok + " n=" + n + " err=" + Marshal.GetLastWin32Error();
    }
}
