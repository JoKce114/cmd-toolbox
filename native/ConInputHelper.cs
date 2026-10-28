using System;
using System.Globalization;
using System.Runtime.InteropServices;

internal static class ConInputHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct KEY_EVENT_RECORD
    {
        public int bKeyDown;
        public ushort wRepeatCount;
        public ushort wVirtualKeyCode;
        public ushort wVirtualScanCode;
        public char UnicodeChar;
        public uint dwControlKeyState;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct COORD
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSE_EVENT_RECORD
    {
        public COORD dwMousePosition;
        public uint dwButtonState;
        public uint dwControlKeyState;
        public uint dwEventFlags;
    }

    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)]
    private struct INPUT_RECORD
    {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
        [FieldOffset(4)] public MOUSE_EVENT_RECORD MouseEvent;
    }

    private delegate bool HandlerRoutine(uint controlType);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AttachConsole(uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetConsoleCtrlHandler(HandlerRoutine handler, bool add);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool WriteConsoleInputW(IntPtr handle, INPUT_RECORD[] records, uint length, out uint written);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetConsoleMode(IntPtr handle, out uint mode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private const uint ENABLE_MOUSE_INPUT = 0x0010;
    private const uint FROM_LEFT_1ST_BUTTON_PRESSED = 0x0001;
    private const uint LEFT_ALT_PRESSED = 0x0002;
    private const ushort KEY_EVENT = 1;
    private const ushort VK_MENU = 0x12;
    private const ushort VK_V = 0x56;

    private static int Main()
    {
        FreeConsole();
        SetConsoleCtrlHandler(controlType => true, true);

        string line;
        while ((line = Console.ReadLine()) != null)
        {
            string[] parts = line.Trim().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) continue;

            uint pid;
            short col;
            short row;
            if (string.Equals(parts[0], "wheel", StringComparison.Ordinal))
            {
                int delta;
                if (parts.Length != 5 ||
                    !uint.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid == 0 ||
                    !int.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out delta) || delta == 0 ||
                    !short.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out col) ||
                    !short.TryParse(parts[4], NumberStyles.Integer, CultureInfo.InvariantCulture, out row))
                {
                    Console.WriteLine("error parse");
                    continue;
                }
                Console.WriteLine(InjectWheel(pid, delta, col, row));
            }
            else if (string.Equals(parts[0], "click", StringComparison.Ordinal))
            {
                if (parts.Length != 4 ||
                    !uint.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid == 0 ||
                    !short.TryParse(parts[2], NumberStyles.Integer, CultureInfo.InvariantCulture, out col) ||
                    !short.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out row))
                {
                    Console.WriteLine("error parse");
                    continue;
                }
                Console.WriteLine(InjectClick(pid, col, row));
            }
            else if (string.Equals(parts[0], "altv", StringComparison.Ordinal))
            {
                if (parts.Length != 2 ||
                    !uint.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid == 0)
                {
                    Console.WriteLine("error parse");
                    continue;
                }
                Console.WriteLine(InjectAltV(pid));
            }
        }
        return 0;
    }

    private static string InjectWheel(uint pid, int delta, short col, short row)
    {
        if (!AttachConsole(pid))
        {
            return "error attach " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture);
        }

        IntPtr input = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (input == IntPtr.Zero || input == new IntPtr(-1))
        {
            int error = Marshal.GetLastWin32Error();
            FreeConsole();
            return "error open " + error.ToString(CultureInfo.InvariantCulture);
        }

        INPUT_RECORD record = new INPUT_RECORD();
        record.EventType = 2;
        record.MouseEvent.dwMousePosition.X = col;
        record.MouseEvent.dwMousePosition.Y = row;
        record.MouseEvent.dwButtonState = unchecked((uint)(delta << 16));
        record.MouseEvent.dwControlKeyState = 0;
        record.MouseEvent.dwEventFlags = 4;

        uint written;
        bool ok = WriteConsoleInputW(input, new[] { record }, 1, out written);
        int result = Marshal.GetLastWin32Error();

        CloseHandle(input);
        FreeConsole();
        return ok ? "ok" : "error write " + result.ToString(CultureInfo.InvariantCulture);
    }

    private static string InjectClick(uint pid, short col, short row)
    {
        if (!AttachConsole(pid))
        {
            return "error attach " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture);
        }

        IntPtr input = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (input == IntPtr.Zero || input == new IntPtr(-1))
        {
            int error = Marshal.GetLastWin32Error();
            FreeConsole();
            return "error open " + error.ToString(CultureInfo.InvariantCulture);
        }

        uint mode;
        if (!GetConsoleMode(input, out mode))
        {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(input);
            FreeConsole();
            return "error mode " + error.ToString(CultureInfo.InvariantCulture);
        }
        if ((mode & ENABLE_MOUSE_INPUT) == 0)
        {
            CloseHandle(input);
            FreeConsole();
            return "skip nomouse " + mode.ToString(CultureInfo.InvariantCulture);
        }

        INPUT_RECORD move = new INPUT_RECORD();
        move.EventType = 2;
        move.MouseEvent.dwMousePosition.X = col;
        move.MouseEvent.dwMousePosition.Y = row;
        move.MouseEvent.dwButtonState = 0;
        move.MouseEvent.dwControlKeyState = 0;
        move.MouseEvent.dwEventFlags = 1;

        INPUT_RECORD down = move;
        down.MouseEvent.dwButtonState = FROM_LEFT_1ST_BUTTON_PRESSED;
        down.MouseEvent.dwEventFlags = 0;

        INPUT_RECORD up = down;
        up.MouseEvent.dwButtonState = 0;

        uint written;
        bool ok = WriteConsoleInputW(input, new[] { move, down, up }, 3, out written);
        int result = Marshal.GetLastWin32Error();

        CloseHandle(input);
        FreeConsole();
        return ok ? "ok" : "error write " + result.ToString(CultureInfo.InvariantCulture);
    }

    private static INPUT_RECORD KeyRecord(int down, ushort virtualKey, ushort scan, char unicode, uint control)
    {
        INPUT_RECORD record = new INPUT_RECORD();
        record.EventType = KEY_EVENT;
        record.KeyEvent.bKeyDown = down;
        record.KeyEvent.wRepeatCount = 1;
        record.KeyEvent.wVirtualKeyCode = virtualKey;
        record.KeyEvent.wVirtualScanCode = scan;
        record.KeyEvent.UnicodeChar = unicode;
        record.KeyEvent.dwControlKeyState = control;
        return record;
    }

    private static string InjectAltV(uint pid)
    {
        if (!AttachConsole(pid))
        {
            return "error attach " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture);
        }

        IntPtr input = CreateFileW("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (input == IntPtr.Zero || input == new IntPtr(-1))
        {
            int error = Marshal.GetLastWin32Error();
            FreeConsole();
            return "error open " + error.ToString(CultureInfo.InvariantCulture);
        }

        INPUT_RECORD[] records = new[]
        {
            KeyRecord(1, VK_MENU, 0x38, '\0', LEFT_ALT_PRESSED),
            KeyRecord(1, VK_V, 0x2F, 'v', LEFT_ALT_PRESSED),
            KeyRecord(0, VK_V, 0x2F, 'v', LEFT_ALT_PRESSED),
            KeyRecord(0, VK_MENU, 0x38, '\0', 0),
        };

        uint written;
        bool ok = WriteConsoleInputW(input, records, (uint)records.Length, out written);
        int result = Marshal.GetLastWin32Error();

        CloseHandle(input);
        FreeConsole();
        return ok ? "ok" : "error write " + result.ToString(CultureInfo.InvariantCulture);
    }
}
