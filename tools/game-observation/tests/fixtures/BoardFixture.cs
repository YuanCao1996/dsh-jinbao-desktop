using System;
using System.Drawing;
using System.Windows.Forms;

public class GenericBoardFixture : Form {
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hwnd);
    [System.Runtime.InteropServices.DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    public GenericBoardFixture() {
        Text = "Generic Board Fixture";
        ClientSize = new Size(640, 640);
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        TopMost = true;
        var timer = new Timer { Interval = 45000 };
        timer.Tick += (sender, args) => { timer.Stop(); Close(); };
        Shown += (sender, args) => {
            var overlay = new FixtureOverlay();
            overlay.Location = new Point(Left + 200, Top + 240);
            overlay.Show(this);
            var ready = new Timer { Interval = 200 };
            ready.Tick += (s, a) => {
                ready.Stop();
                Activate();
                bool active = SetForegroundWindow(Handle);
                Console.WriteLine("fixture_ready pid=" + System.Diagnostics.Process.GetCurrentProcess().Id + " handle=" + Handle.ToInt64() + " active=" + active + " foreground=" + GetForegroundWindow().ToInt64() + " title=" + Text);
                Console.Out.Flush();
                ready.Dispose();
            };
            ready.Start();
            timer.Start();
        };
    }
    protected override void OnPaint(PaintEventArgs args) {
        base.OnPaint(args);
        Graphics g = args.Graphics;
        g.Clear(Color.FromArgb(205, 170, 115));
        float step = 520f / 14;
        using (var pen = new Pen(Color.FromArgb(35, 35, 35), 1)) {
            for (int n = 0; n < 15; n++) {
                g.DrawLine(pen, 60 + n * step, 60, 60 + n * step, 580);
                g.DrawLine(pen, 60, 60 + n * step, 580, 60 + n * step);
            }
        }
        Piece(g, 0, 0, Color.FromArgb(18, 18, 18), step);
        Piece(g, 7, 7, Color.FromArgb(18, 18, 18), step);
        Piece(g, 8, 7, Color.FromArgb(245, 245, 245), step);
        Piece(g, 14, 14, Color.FromArgb(245, 245, 245), step);
    }
    private void Piece(Graphics g, int col, int row, Color color, float step) {
        float radius = step * 0.37f;
        using (var brush = new SolidBrush(color)) {
            g.FillEllipse(brush, 60 + col * step - radius, 60 + row * step - radius, radius * 2, radius * 2);
        }
    }
    public static void Run() { Application.Run(new GenericBoardFixture()); }
}

public class FixtureOverlay : Form {
    public FixtureOverlay() {
        Text = "Jinbao fixture overlay";
        BackColor = Color.Magenta;
        ClientSize = new Size(240, 160);
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override CreateParams CreateParams {
        get { var value = base.CreateParams; value.ExStyle |= 0x08000080; return value; }
    }
}
