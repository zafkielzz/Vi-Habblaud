// Windows: terminate a Claude Code session running in another terminal without leaving the terminal "dirty".
// Claude Code turns on terminal modes (mouse, focus, extended keyboard, win32-input-mode, bracketed paste,
// alternate screen) and turns them off when exiting normally. If forcibly terminated (TerminateProcess),
// nothing turns them off and Windows Terminal sends mouse/focus events to the shell as raw text.
// Therefore an auxiliary PowerShell attaches to the session console (AttachConsole), terminates the process,
// writes the sequences to turn off these modes into that console, and restores console input mode to normal.
// Before terminating, the helper verifies that PID is still the same process (exact start time, FILETIME):
// a PID reused by another program will not be terminated.
import { execFile } from 'node:child_process';
import { tr } from '../../shared/i18n';

/** Turns off what Claude Code turns on: mouse, focus, paste, keyboard (kitty and win32-input), alternate screen. */
export const TERMINAL_RESET =
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?2031l\x1b[?9001l\x1b[<u\x1b[>4;0m\x1b[?25h\x1b[0m\r\n';

function script(pid: number, fileTime: string): string {
  const reset = [...TERMINAL_RESET].map((c) => `[char]${c.charCodeAt(0)}`).join('+');
  return `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class HabblaudConsole {
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr sec, uint d, uint f, IntPtr t);
  [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
  [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool WriteConsoleW(IntPtr h, string s, uint n, out uint w, IntPtr r);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
"@
$target = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if (-not $target -or $target.StartTime.ToFileTimeUtc() -ne ${fileTime}) { exit 4 }
[HabblaudConsole]::FreeConsole() | Out-Null
$attached = [HabblaudConsole]::AttachConsole(${pid})
Stop-Process -Id ${pid} -Force
if (-not $attached) { exit 3 }
for ($i = 0; $i -lt 30 -and (Get-Process -Id ${pid} -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }
Start-Sleep -Milliseconds 150
$out = [HabblaudConsole]::CreateFileW('CONOUT$', ([uint32]3221225472), 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
$m = 0
if ([HabblaudConsole]::GetConsoleMode($out, [ref]$m)) { [HabblaudConsole]::SetConsoleMode($out, $m -bor 4) | Out-Null }
$s = ${reset}
$w = 0
[HabblaudConsole]::WriteConsoleW($out, $s, $s.Length, [ref]$w, [IntPtr]::Zero) | Out-Null
[HabblaudConsole]::CloseHandle($out) | Out-Null
$in = [HabblaudConsole]::CreateFileW('CONIN$', ([uint32]3221225472), 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
if ([HabblaudConsole]::GetConsoleMode($in, [ref]$m)) {
  # No VT input (0x200) and with line, echo, and processed input: shell receives normal keystrokes again.
  [HabblaudConsole]::SetConsoleMode($in, (($m -band (-bnot 0x200)) -bor 0x7)) | Out-Null
}
[HabblaudConsole]::CloseHandle($in) | Out-Null
[HabblaudConsole]::FreeConsole() | Out-Null
`;
}

/**
 * Terminates `pid` (only if it still started at `fileTime`) and cleans up its terminal modes. If the helper fails
 * before terminating, terminates directly, as long as `stillSame` reconfirms it is the same process (the terminal
 * may keep modes enabled, as before).
 */
export function killWithConsoleReset(pid: number, fileTime: string, stillSame: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.reject(new Error(tr('invalid pid')));
  if (!/^\d+$/.test(fileTime)) return Promise.reject(new Error(tr('unknown process start time')));
  const encoded = Buffer.from(script(pid, fileTime), 'utf16le').toString('base64');
  return new Promise((ok, fail) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs },
      (err) => {
        if ((err as { code?: unknown } | null)?.code === 4) return fail(new Error(tr('the process is no longer that session')));
        void stillSame()
          .then((same) => {
            if (same) process.kill(pid);
          })
          .catch(() => undefined)
          .finally(ok);
      },
    );
  });
}
