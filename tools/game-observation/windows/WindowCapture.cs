using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace GenericGameCapture {
    public class WindowInfo {
        public string id;
        public string title;
        public int pid;
        public int width;
        public int height;
        public bool foreground;
    }
    public class Frame {
        public string target_id;
        public int width;
        public int height;
        public long captured_at_ms;
        public string png_base64;
        public string rgb_base64;
        public bool assistant_excluded = true;
        public string exclusion_method = "target_client_render_only";
        public string source = "windows_printwindow";
    }
    public static class Native {
        private delegate bool EnumProc(IntPtr hwnd, IntPtr data);
        [StructLayout(LayoutKind.Sequential)] private struct Rect { public int left, top, right, bottom; }
        [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr data);
        [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
        [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
        [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
        [StructLayout(LayoutKind.Sequential)] private struct FileTime { public uint low, high; }
        [DllImport("kernel32.dll")] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder text, ref int size);
        [DllImport("kernel32.dll")] private static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);

        public static void Initialize() {
            if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero)
                throw new InvalidOperationException("dpi_context_unavailable");
        }
        private static WindowInfo Describe(IntPtr hwnd) {
            if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return null;
            var windowClass = new StringBuilder(256);
            GetClassName(hwnd, windowClass, windowClass.Capacity);
            if (windowClass.ToString() == "Progman" || windowClass.ToString() == "WorkerW"
                || windowClass.ToString() == "Shell_TrayWnd") return null;
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            // Query-only identity does not require reading another process's memory.
            IntPtr handle = OpenProcess(0x1000, false, pid);
            if (handle == IntPtr.Zero) return null;
            try {
                    var imagePath = new StringBuilder(1024);
                    int capacity = imagePath.Capacity;
                    FileTime created, exited, kernel, user;
                    if (!QueryFullProcessImageName(handle, 0, imagePath, ref capacity)
                        || !GetProcessTimes(handle, out created, out exited, out kernel, out user)) return null;
                    string name = Path.GetFileNameWithoutExtension(imagePath.ToString()).ToLowerInvariant();
                    if (name.Contains("league") || name.Contains("riotclient")) return null;
                    var text = new StringBuilder(512);
                    GetWindowText(hwnd, text, text.Capacity);
                    string title = text.ToString();
                    if (title.Length == 0 || title.IndexOf("jinbao", StringComparison.OrdinalIgnoreCase) >= 0
                        || title.Contains("\u91d1\u5b9d")) return null;
                    Rect rect;
                    if (!GetClientRect(hwnd, out rect)) return null;
                    int width = rect.right - rect.left, height = rect.bottom - rect.top;
                    if (width < 1 || height < 1 || (long)width * height > 8 * 1024 * 1024) return null;
                    return new WindowInfo {
                        id = "win-" + hwnd.ToInt64().ToString("x") + "-" + pid + "-" + (((ulong)created.high << 32) | created.low),
                        title = title, pid = (int)pid, width = width, height = height,
                        foreground = GetAncestor(GetForegroundWindow(), 2) == hwnd
                    };
            } catch (ArgumentException) { return null; }
              catch (InvalidOperationException) { return null; }
              catch (System.ComponentModel.Win32Exception) { return null; }
              finally { CloseHandle(handle); }
        }
        public static WindowInfo[] List() {
            var values = new List<WindowInfo>();
            EnumWindows((hwnd, data) => { var value = Describe(hwnd); if (value != null) values.Add(value); return true; }, IntPtr.Zero);
            return values.ToArray();
        }
        public static Frame Capture(string id, int expectedWidth, int expectedHeight,
                                    int x, int y, int width, int height, int outWidth, int outHeight) {
            IntPtr selected = IntPtr.Zero;
            WindowInfo before = null;
            EnumWindows((hwnd, data) => {
                var value = Describe(hwnd);
                if (value != null && value.id == id) { selected = hwnd; before = value; return false; }
                return true;
            }, IntPtr.Zero);
            if (before == null) throw new InvalidOperationException("target_not_available");
            if (GetForegroundWindow() == IntPtr.Zero) throw new InvalidOperationException("foreground_unavailable");
            if (!before.foreground) throw new InvalidOperationException("target_not_foreground");
            if (before.width != expectedWidth || before.height != expectedHeight)
                throw new InvalidOperationException("target_geometry_changed");
            if (x < 0 || y < 0 || width < 1 || height < 1 || (long)x + width > before.width
                || (long)y + height > before.height || outWidth < 1 || outHeight < 1
                || outWidth > width || outHeight > height || outWidth > 2048 || outHeight > 2048)
                throw new InvalidOperationException("invalid_capture_geometry");
            long captured = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            using (var full = new Bitmap(before.width, before.height, PixelFormat.Format32bppArgb)) {
                using (Graphics graphics = Graphics.FromImage(full)) {
                    graphics.Clear(Color.Magenta);
                    IntPtr hdc = graphics.GetHdc();
                    bool ok;
                    try { ok = PrintWindow(selected, hdc, 1); } finally { graphics.ReleaseHdc(hdc); }
                    if (!ok) throw new InvalidOperationException("window_render_unavailable");
                }
                var after = Describe(selected);
                if (after == null || after.id != id || !after.foreground || before.width != after.width || before.height != after.height)
                    throw new InvalidOperationException("target_changed_during_capture");
                using (var image = new Bitmap(outWidth, outHeight, PixelFormat.Format32bppArgb)) {
                    using (Graphics graphics = Graphics.FromImage(image)) {
                        graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        graphics.DrawImage(full, new Rectangle(0, 0, outWidth, outHeight), x, y, width, height, GraphicsUnit.Pixel);
                    }
                    return Encode(image, id, captured);
                }
            }
        }
        public static Frame Encode(Bitmap image, string id, long captured) {
            byte[] rgb = new byte[checked(image.Width * image.Height * 3)];
            BitmapData data = image.LockBits(new Rectangle(0, 0, image.Width, image.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try {
                byte[] row = new byte[image.Width * 4];
                for (int y = 0; y < image.Height; y++) {
                    Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                    for (int x = 0; x < image.Width; x++) {
                        int i = (y * image.Width + x) * 3, j = x * 4;
                        rgb[i] = row[j + 2]; rgb[i + 1] = row[j + 1]; rgb[i + 2] = row[j];
                    }
                }
            } finally { image.UnlockBits(data); }
            using (var stream = new MemoryStream()) {
                image.Save(stream, ImageFormat.Png);
                return new Frame { target_id = id, width = image.Width, height = image.Height,
                    captured_at_ms = captured, png_base64 = Convert.ToBase64String(stream.ToArray()),
                    rgb_base64 = Convert.ToBase64String(rgb) };
            }
        }
    }
}
