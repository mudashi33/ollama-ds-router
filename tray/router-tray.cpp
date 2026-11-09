// router-tray.cpp  --  Ollama/DeepSeek 时间路由 · 模式切换托盘小工具
// 依赖：Win32 + WinHTTP，静态链接 CRT（/MT），单 exe，无需任何运行库
#define WIN32_LEAN_AND_MEAN
#define _CRT_SECURE_NO_WARNINGS

#include <windows.h>
#include <windowsx.h>
#include <winhttp.h>
#include <shellapi.h>
#include <string>
#include <map>
#include <atomic>
#include <thread>
#include <cstdio>
#include <cstdarg>
#include <cstdlib>
#include <cstring>

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(linker, "/manifestdependency:\"type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'\"")

// ------------------------------------------------------------------ 常量
#define APP_TITLE   L"时间路由 · 模式切换"
#define APP_CLASS   L"RouterTrayWnd"
#define REG_PATH    L"Software\\OllamaDsRouterTray"
#define HOST_PORT   8788

#define IDC_MODE_BASE 1000
#define IDC_TRAYCHK   1010
#define IDC_EFFECTIVE 1011
#define IDC_PROVIDER  1012
#define IDC_REASON    1013
#define IDC_DS_PEAK   1014
#define IDC_OL_PEAK   1015
#define IDC_BAL_DS    1016
#define IDC_BAL_OL    1017
#define IDC_TODAY     1018
#define IDC_FOOTER    1019
#define IDC_REFRESH   1020

#define IDM_MODE_BASE 2000
#define IDM_SHOW      2100
#define IDM_EXIT      2101
#define IDM_DASH      2102
#define IDM_COPY      2103

// 余额低于这个值就在托盘上变黄提醒一次（DS 计人民币，Ollama 计美元）
#define LOW_BALANCE_DS 5.0
#define LOW_BALANCE_OL 5.0

#define WM_APP_SNAP   (WM_APP + 1)
#define WM_APP_TRAY   (WM_APP + 2)

#define TIMER_POLL 1
#define TRAY_ID    1

// ------------------------------------------------------------------ 全局
static HINSTANCE g_inst;
static HWND      g_hwnd;
static HFONT     g_fontN, g_fontB, g_fontS;
static HBRUSH    g_bg;
static HICON     g_icon;          // 托盘/窗口图标（按上游变色）
static int       g_dpi = 96;
static bool      g_trayShown = true;
static bool      g_reachable = false;
static std::wstring g_mode = L"auto-ds";
static std::atomic<bool> g_busy{false};

static const struct { const wchar_t* key; const wchar_t* label; } MODES[4] = {
  { L"auto-ds",     L"自动 · 以 DS 空闲为准" },
  { L"auto-ollama", L"自动 · 以 Ollama 空闲为准" },
  { L"ollama",      L"强制 Ollama" },
  { L"deepseek",    L"强制 DeepSeek 官方" },
};

static int S(int v) { return MulDiv(v, g_dpi, 96); }

// ------------------------------------------------------------------ 工具
static std::wstring U8(const std::string& s) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
  return w;
}
static std::string W8(const std::wstring& w) {
  if (w.empty()) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}
static void SetText(int id, const std::wstring& text) {
  HWND h = GetDlgItem(g_hwnd, id);
  if (h) SetWindowTextW(h, text.c_str());
}
static void Redraw(int id) {
  HWND h = GetDlgItem(g_hwnd, id);
  if (h) InvalidateRect(h, nullptr, TRUE);
}

static bool RegGetBool(const wchar_t* name, bool def) {
  DWORD v = 0, sz = sizeof(v), type = 0;
  if (RegGetValueW(HKEY_CURRENT_USER, REG_PATH, name, RRF_RT_REG_DWORD, &type, &v, &sz) == ERROR_SUCCESS) return v != 0;
  return def;
}
static void RegSetBool(const wchar_t* name, bool val) {
  HKEY k;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, REG_PATH, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &k, nullptr) == ERROR_SUCCESS) {
    DWORD v = val ? 1 : 0;
    RegSetValueExW(k, name, 0, REG_DWORD, (const BYTE*)&v, sizeof(v));
    RegCloseKey(k);
  }
}

// ------------------------------------------------------------------ 圆形彩色图标（按上游变色）
static HICON MakeDotIcon(COLORREF c, int size) {
  BITMAPV5HEADER bi = {};
  bi.bV5Size = sizeof(bi);
  bi.bV5Width = size;
  bi.bV5Height = -size;
  bi.bV5Planes = 1;
  bi.bV5BitCount = 32;
  bi.bV5Compression = BI_BITFIELDS;
  bi.bV5RedMask = 0x00FF0000;
  bi.bV5GreenMask = 0x0000FF00;
  bi.bV5BlueMask = 0x000000FF;
  bi.bV5AlphaMask = 0xFF000000;

  void* bits = nullptr;
  HDC hdc = GetDC(nullptr);
  HBITMAP color = CreateDIBSection(hdc, (BITMAPINFO*)&bi, DIB_RGB_COLORS, &bits, nullptr, 0);
  ReleaseDC(nullptr, hdc);
  if (!color || !bits) return nullptr;

  BYTE* px = (BYTE*)bits;
  const double cx = size / 2.0, cy = size / 2.0;
  const double rOuter = size * 0.46, rInner = size * 0.34;
  const int SS = 4;
  for (int y = 0; y < size; y++) {
    for (int x = 0; x < size; x++) {
      int hit = 0, ringHit = 0;
      for (int sy = 0; sy < SS; sy++) {
        for (int sx = 0; sx < SS; sx++) {
          double px_ = x + (sx + 0.5) / SS - cx;
          double py_ = y + (sy + 0.5) / SS - cy;
          double d = px_ * px_ + py_ * py_;
          if (d <= rOuter * rOuter) hit++;
          if (d <= rInner * rInner) ringHit++;
        }
      }
      BYTE a = (BYTE)(hit * 255 / (SS * SS));
      if (!a) continue;
      // 外圈白边 + 内圈颜色：环内用颜色，环外圈用白色
      bool core = ringHit * 2 >= SS * SS;
      COLORREF cc = core ? c : RGB(245, 245, 245);
      BYTE* p = px + (y * size + x) * 4;
      p[0] = (BYTE)(GetBValue(cc) * a / 255);
      p[1] = (BYTE)(GetGValue(cc) * a / 255);
      p[2] = (BYTE)(GetRValue(cc) * a / 255);
      p[3] = a;
    }
  }
  HBITMAP mask = CreateBitmap(size, size, 1, 1, nullptr);
  ICONINFO ii = {};
  ii.fIcon = TRUE;
  ii.hbmMask = mask;
  ii.hbmColor = color;
  HICON icon = CreateIconIndirect(&ii);
  DeleteObject(color);
  DeleteObject(mask);
  return icon;
}

// ------------------------------------------------------------------ HTTP
static bool HttpGet(const std::wstring& pathAndQuery, std::string& out, DWORD& status) {
  out.clear();
  status = 0;
  HINTERNET ses = WinHttpOpen(L"RouterTray/1.0", WINHTTP_ACCESS_TYPE_NO_PROXY,
                              WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!ses) return false;
  WinHttpSetTimeouts(ses, 2000, 2000, 2000, 4000);
  bool ok = false;
  HINTERNET con = WinHttpConnect(ses, L"127.0.0.1", HOST_PORT, 0);
  if (con) {
    HINTERNET req = WinHttpOpenRequest(con, L"GET", pathAndQuery.c_str(), nullptr,
                                       WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    if (req) {
      if (WinHttpSendRequest(req, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
          WinHttpReceiveResponse(req, nullptr)) {
        DWORD code = 0, len = sizeof(code);
        WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &code, &len, WINHTTP_NO_HEADER_INDEX);
        status = code;
        DWORD avail = 0;
        do {
          avail = 0;
          if (!WinHttpQueryDataAvailable(req, &avail) || !avail) break;
          std::string buf(avail, '\0');
          DWORD read = 0;
          if (!WinHttpReadData(req, &buf[0], avail, &read) || !read) break;
          out.append(buf.data(), read);
          if (out.size() > 1024 * 1024) break;
        } while (avail > 0);
        ok = (code == 200);
      }
      WinHttpCloseHandle(req);
    }
    WinHttpCloseHandle(con);
  }
  WinHttpCloseHandle(ses);
  return ok;
}

struct Snap {
  std::map<std::string, std::string> kv;
  bool ok = false;
  std::string Get(const char* k) const {
    auto it = kv.find(k);
    return it == kv.end() ? std::string() : it->second;
  }
  bool Flag(const char* k) const { return Get(k) == "1"; }
};

static void ParseSnap(const std::string& body, Snap& s) {
  size_t pos = 0;
  while (pos < body.size()) {
    size_t eol = body.find('\n', pos);
    if (eol == std::string::npos) eol = body.size();
    std::string line = body.substr(pos, eol - pos);
    pos = eol + 1;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    size_t eq = line.find('=');
    if (eq == std::string::npos) continue;
    s.kv[line.substr(0, eq)] = line.substr(eq + 1);
  }
  s.ok = !s.kv.empty();
}

// 最近一次快照留在进程里，供托盘菜单「复制状态」用（不额外发请求）
static Snap g_last;
static bool g_lastOk = false;
static bool g_lowWarned = false;

static bool ParseMoney(const std::string& s, double& out) {
  std::string num;
  for (size_t i = 0; i < s.size(); i++) {
    char c = s[i];
    if ((c >= '0' && c <= '9') || c == '.') num += c;
  }
  if (num.empty()) return false;
  out = atof(num.c_str());
  return true;
}

// 返回 true 时 msg 里是「哪一家余额低了」的说明
static bool LowBalance(std::wstring& msg) {
  if (!g_lastOk) return false;
  bool low = false;
  double v = 0;
  if (g_last.Flag("deepseekOk") && ParseMoney(g_last.Get("deepseekBalance"), v) && v < LOW_BALANCE_DS) {
    if (low) msg += L"；";
    msg += L"DeepSeek 余额 " + U8(g_last.Get("deepseekBalance")) + L"（低于 ¥5）";
    low = true;
  }
  if (g_last.Flag("ollamaOk") && ParseMoney(g_last.Get("ollamaBalance"), v) && v < LOW_BALANCE_OL) {
    if (low) msg += L"；";
    msg += L"Ollama 余额 " + U8(g_last.Get("ollamaBalance")) + L"（低于 $5）";
    low = true;
  }
  return low;
}

static void CopyToClipboard(const std::wstring& text) {
  if (!OpenClipboard(g_hwnd)) return;
  EmptyClipboard();
  size_t bytes = (text.size() + 1) * sizeof(wchar_t);
  HGLOBAL h = GlobalAlloc(GMEM_MOVEABLE, bytes);
  if (h) {
    void* dst = GlobalLock(h);
    if (dst) {
      memcpy(dst, text.c_str(), bytes);
      GlobalUnlock(h);
      SetClipboardData(CF_UNICODETEXT, h);
    } else {
      GlobalFree(h);
    }
  }
  CloseClipboard();
}

static std::wstring StatusText() {
  if (!g_lastOk) return L"时间路由：连不上 127.0.0.1:8788";
  std::wstring t;
  t += L"时间路由 · " + U8(g_last.Get("label")) + L"（" + U8(g_last.Get("mode")) + L"）\n";
  t += L"此刻北京时间：" + U8(g_last.Get("beijing")) + L"\n";
  t += L"正在使用：" + U8(g_last.Get("providerLabel")) + L"\n";
  t += L"原因：" + U8(g_last.Get("reason")) + L"\n";
  t += L"下次切换：" + U8(g_last.Get("nextSwitch")) + L"\n";
  t += L"DeepSeek 余额：" + U8(g_last.Get("deepseekBalance"));
  if (!g_last.Flag("deepseekOk")) t += L"（取不到：" + U8(g_last.Get("deepseekError")) + L"）";
  t += L"\n";
  t += L"Ollama 余额：" + U8(g_last.Get("ollamaBalance"));
  if (!g_last.Get("ollamaUntil").empty())
    t += L"（套餐 $" + U8(g_last.Get("ollamaAllowance")) + L"，可用到 " + U8(g_last.Get("ollamaUntil")) + L"）";
  t += L"\n";
  t += L"今天：" + U8(g_last.Get("todayRequests")) + L" 次请求 · 花费 ¥" + U8(g_last.Get("todayCostCny"));
  return t;
}

static void ShowLowBalanceBalloon(const std::wstring& msg) {
  if (!g_trayShown) return;
  NOTIFYICONDATAW nid = {};
  nid.cbSize = sizeof(nid);
  nid.hWnd = g_hwnd;
  nid.uID = TRAY_ID;
  nid.uFlags = NIF_INFO;
  nid.dwInfoFlags = NIIF_WARNING;
  wcsncpy_s(nid.szInfoTitle, L"余额偏低", _TRUNCATE);
  wcsncpy_s(nid.szInfo, msg.c_str(), _TRUNCATE);
  Shell_NotifyIconW(NIM_MODIFY, &nid);
}

// ------------------------------------------------------------------ 托盘
static void UpdateTrayIcon(const Snap* s) {
  COLORREF c = RGB(140, 148, 158); // 连不上：灰
  if (s && s->ok) {
    std::string p = s->Get("provider");
    if (p == "ollama") c = RGB(46, 160, 67);        // 绿：Ollama
    else if (p == "deepseek") c = RGB(31, 111, 235); // 蓝：官方
  }
  std::wstring lowMsg;
  if (LowBalance(lowMsg)) c = RGB(219, 154, 4);      // 黄：某一家余额偏低
  // 颜色没变就不重建图标（每 3 秒一次轮询，没必要一直分配 HICON）
  static COLORREF lastColor = (COLORREF)-1;
  static int lastSize = 0;
  const int size = S(32);
  if (!g_icon || c != lastColor || size != lastSize) {
    HICON old = g_icon;
    g_icon = MakeDotIcon(c, size);
    if (g_icon) {
      SendMessageW(g_hwnd, WM_SETICON, ICON_BIG, (LPARAM)g_icon);
      SendMessageW(g_hwnd, WM_SETICON, ICON_SMALL, (LPARAM)g_icon);
    }
    if (old) DestroyIcon(old);
    lastColor = c;
    lastSize = size;
  }

  if (!g_trayShown) return;
  NOTIFYICONDATAW nid = {};
  nid.cbSize = sizeof(nid);
  nid.hWnd = g_hwnd;
  nid.uID = TRAY_ID;
  nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  nid.uCallbackMessage = WM_APP_TRAY;
  nid.hIcon = g_icon;
  std::wstring tip = APP_TITLE;
  if (s && s->ok) {
    tip = L"时间路由 · " + U8(s->Get("label")) + L"\n当前：" + U8(s->Get("providerLabel"));
  } else if (s) {
    tip = L"时间路由 · 连不上路由器";
  }
  wcsncpy_s(nid.szTip, tip.c_str(), _TRUNCATE);
  Shell_NotifyIconW(NIM_MODIFY, &nid);
}

// 托盘诊断日志：%LOCALAPPDATA%\OllamaDsRouterTray\tray.log
static void TrayLog(const wchar_t* fmt, ...) {
  wchar_t dir[MAX_PATH] = {};
  if (!GetEnvironmentVariableW(L"LOCALAPPDATA", dir, MAX_PATH)) return;
  wcscat_s(dir, L"\\OllamaDsRouterTray");
  CreateDirectoryW(dir, nullptr);
  wcscat_s(dir, L"\\tray.log");
  wchar_t line[512];
  va_list ap;
  va_start(ap, fmt);
  _vsnwprintf_s(line, _TRUNCATE, fmt, ap);
  va_end(ap);
  FILE* f = nullptr;
  if (_wfopen_s(&f, dir, L"a, ccs=UTF-8") == 0 && f) {
    fputws(line, f);
    fclose(f);
  }
}

static void TrayAdd() {
  NOTIFYICONDATAW nid = {};
  nid.cbSize = sizeof(nid);
  nid.hWnd = g_hwnd;
  nid.uID = TRAY_ID;
  nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
  nid.uCallbackMessage = WM_APP_TRAY;
  nid.hIcon = g_icon ? g_icon : LoadIconW(nullptr, IDI_APPLICATION);
  wcscpy_s(nid.szTip, APP_TITLE);
  BOOL added = Shell_NotifyIconW(NIM_ADD, &nid);
  NOTIFYICONIDENTIFIER niid = {};
  niid.cbSize = sizeof(niid);
  niid.hWnd = g_hwnd;
  niid.uID = TRAY_ID;
  RECT rc = {};
  HRESULT hr = Shell_NotifyIconGetRect(&niid, &rc);
  TrayLog(L"[%lu] NIM_ADD ok=%d hr=0x%08X rect=%ld,%ld,%ld,%ld\n",
          GetCurrentProcessId(), added, (unsigned)hr, rc.left, rc.top, rc.right, rc.bottom);
}
static void TrayRemove() {
  NOTIFYICONDATAW nid = {};
  nid.cbSize = sizeof(nid);
  nid.hWnd = g_hwnd;
  nid.uID = TRAY_ID;
  BOOL removed = Shell_NotifyIconW(NIM_DELETE, &nid);
  TrayLog(L"[%lu] NIM_DELETE ok=%d\n", GetCurrentProcessId(), removed);
}

// ------------------------------------------------------------------ 异步刷新
static void PostRefresh() {
  HWND hwnd = g_hwnd;
  std::thread([hwnd]() {
    std::string body;
    DWORD st = 0;
    bool ok = HttpGet(L"/_router/mode", body, st) && st == 200;
    auto* payload = new std::string(ok ? body : std::string());
    PostMessageW(hwnd, WM_APP_SNAP, ok ? 1 : 0, (LPARAM)payload);
  }).detach();
}
static void PostSetMode(const std::wstring& mode) {
  HWND hwnd = g_hwnd;
  std::wstring m = mode;
  std::thread([hwnd, m]() {
    std::string body;
    DWORD st = 0;
    HttpGet(L"/_router/prefer?prefer=" + m, body, st);
    std::string snap;
    DWORD st2 = 0;
    bool ok = HttpGet(L"/_router/mode", snap, st2) && st2 == 200;
    auto* payload = new std::string(ok ? snap : std::string());
    PostMessageW(hwnd, WM_APP_SNAP, ok ? 1 : 0, (LPARAM)payload);
  }).detach();
}

// ------------------------------------------------------------------ 布局
static void Layout() {
  const int W = S(470);
  const int pad = S(16);
  const int rowH = S(22);
  int y = S(12);

  MoveWindow(GetDlgItem(g_hwnd, IDC_MODE_BASE + 0), pad, y, W - pad * 2, rowH, TRUE); y += S(24);
  MoveWindow(GetDlgItem(g_hwnd, IDC_MODE_BASE + 1), pad, y, W - pad * 2, rowH, TRUE); y += S(24);
  MoveWindow(GetDlgItem(g_hwnd, IDC_MODE_BASE + 2), pad, y, W - pad * 2, rowH, TRUE); y += S(24);
  MoveWindow(GetDlgItem(g_hwnd, IDC_MODE_BASE + 3), pad, y, W - pad * 2, rowH, TRUE); y += S(30);

  MoveWindow(GetDlgItem(g_hwnd, IDC_EFFECTIVE), pad, y, W - pad * 2, rowH, TRUE); y += S(24);
  MoveWindow(GetDlgItem(g_hwnd, IDC_PROVIDER),  pad, y, W - pad * 2, rowH, TRUE); y += S(20);
  MoveWindow(GetDlgItem(g_hwnd, IDC_REASON),    pad, y, W - pad * 2, rowH, TRUE); y += S(30);

  MoveWindow(GetDlgItem(g_hwnd, IDC_DS_PEAK), pad, y, W - pad * 2, rowH, TRUE); y += S(22);
  MoveWindow(GetDlgItem(g_hwnd, IDC_OL_PEAK), pad, y, W - pad * 2, rowH, TRUE); y += S(28);

  MoveWindow(GetDlgItem(g_hwnd, IDC_BAL_DS), pad, y, W - pad * 2, rowH, TRUE); y += S(22);
  MoveWindow(GetDlgItem(g_hwnd, IDC_BAL_OL), pad, y, W - pad * 2, rowH, TRUE); y += S(22);
  MoveWindow(GetDlgItem(g_hwnd, IDC_TODAY),  pad, y, W - pad * 2, rowH, TRUE); y += S(30);

  MoveWindow(GetDlgItem(g_hwnd, IDC_TRAYCHK), pad, y, W - pad * 2 - S(84), rowH, TRUE);
  MoveWindow(GetDlgItem(g_hwnd, IDC_REFRESH), W - pad - S(72), y - S(2), S(72), S(26), TRUE);
  y += S(32);
  MoveWindow(GetDlgItem(g_hwnd, IDC_FOOTER), pad, y, W - pad * 2, S(36), TRUE);
}

// ------------------------------------------------------------------ 应用快照
static void ApplySnap(bool ok, const std::string& body) {
  Snap s;
  ParseSnap(body, s);
  g_reachable = ok && s.ok;
  g_last = s;
  g_lastOk = g_reachable;

  if (!g_reachable) {
    g_mode.clear();
    SetText(IDC_EFFECTIVE, L"⚠ 连不上 127.0.0.1:8788（路由器没在跑？）");
    SetText(IDC_PROVIDER, L"—");
    SetText(IDC_REASON, L"在计划任务里跑 «Ollama-DS-Router» 或重启电脑即可拉起");
    SetText(IDC_DS_PEAK, L"DeepSeek 高峰：工作日 09:00–12:00、14:00–18:00");
    SetText(IDC_OL_PEAK, L"Ollama 高峰：工作日 20:00–次日 02:00");
    SetText(IDC_BAL_DS, L"DeepSeek 余额：—");
    SetText(IDC_BAL_OL, L"Ollama 余额：—");
    SetText(IDC_TODAY, L"今天：—");
    UpdateTrayIcon(nullptr);
    Redraw(IDC_EFFECTIVE);
    Redraw(IDC_PROVIDER);
    return;
  }

  g_mode = U8(s.Get("mode"));
  for (int i = 0; i < 4; i++) {
    HWND r = GetDlgItem(g_hwnd, IDC_MODE_BASE + i);
    if (r) SendMessageW(r, BM_SETCHECK, (g_mode == MODES[i].key) ? BST_CHECKED : BST_UNCHECKED, 0);
  }

  SetText(IDC_EFFECTIVE, L"当前生效：" + U8(s.Get("label")) + L"（" + U8(s.Get("beijing")) + L"）");
  SetText(IDC_PROVIDER, L"正在使用：" + U8(s.Get("providerLabel")));
  SetText(IDC_REASON, L"下次切换：" + U8(s.Get("nextSwitch")));

  std::wstring dsPeak = L"DeepSeek 高峰：" + U8(s.Get("deepseekPeakWindow"));
  std::wstring olPeak = L"Ollama 高峰：" + U8(s.Get("ollamaPeakWindow"));
  if (s.Flag("deepseekPeak")) dsPeak += L"　← 现在就是";
  if (s.Flag("ollamaPeak")) olPeak += L"　← 现在就是";
  SetText(IDC_DS_PEAK, dsPeak);
  SetText(IDC_OL_PEAK, olPeak);

  std::wstring balDs = L"DeepSeek 余额：" + U8(s.Get("deepseekBalance"));
  if (!s.Flag("deepseekOk")) balDs += L"（取不到：" + U8(s.Get("deepseekError")) + L"）";
  std::wstring balOl = L"Ollama 余额：" + U8(s.Get("ollamaBalance"));
  if (!s.Get("ollamaUntil").empty()) balOl += L"（套餐 $" + U8(s.Get("ollamaAllowance")) + L"，可用到 " + U8(s.Get("ollamaUntil")) + L"）";
  SetText(IDC_BAL_DS, balDs);
  SetText(IDC_BAL_OL, balOl);
  SetText(IDC_TODAY, L"今天：" + U8(s.Get("todayRequests")) + L" 次请求 · 花费 ¥" + U8(s.Get("todayCostCny")));

  UpdateTrayIcon(&s);

  // 低余额只气泡提醒一次；余额回上去之后再低会重新提醒
  std::wstring lowMsg;
  if (LowBalance(lowMsg)) {
    if (!g_lowWarned) {
      ShowLowBalanceBalloon(lowMsg);
      g_lowWarned = true;
      TrayLog(L"[%lu] low balance balloon: %ls\n", GetCurrentProcessId(), lowMsg.c_str());
    }
  } else {
    g_lowWarned = false;
  }

  Redraw(IDC_DS_PEAK);
  Redraw(IDC_OL_PEAK);
}

// ------------------------------------------------------------------ 托盘菜单
static void ShowTrayMenu() {
  POINT pt;
  GetCursorPos(&pt);
  HMENU m = CreatePopupMenu();
  AppendMenuW(m, MF_STRING | MF_GRAYED, 0, L"时间路由 · 模式");
  AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
  for (int i = 0; i < 4; i++) {
    UINT flags = MF_STRING | ((g_mode == MODES[i].key) ? MF_CHECKED : 0);
    AppendMenuW(m, flags, IDM_MODE_BASE + i, MODES[i].label);
  }
  AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(m, MF_STRING, IDM_SHOW, L"打开窗口");
  AppendMenuW(m, MF_STRING, IDM_DASH, L"打开看板（浏览器）");
  AppendMenuW(m, MF_STRING, IDM_COPY, L"复制状态到剪贴板");
  AppendMenuW(m, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(m, MF_STRING, IDM_EXIT, L"退出");
  SetForegroundWindow(g_hwnd);
  int cmd = (int)TrackPopupMenu(m, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.x, pt.y, 0, g_hwnd, nullptr);
  DestroyMenu(m);
  PostMessageW(g_hwnd, WM_NULL, 0, 0);
  if (cmd >= IDM_MODE_BASE && cmd < IDM_MODE_BASE + 4) {
    PostSetMode(MODES[cmd - IDM_MODE_BASE].key);
  } else if (cmd == IDM_SHOW) {
    ShowWindow(g_hwnd, SW_SHOW);
    SetForegroundWindow(g_hwnd);
  } else if (cmd == IDM_DASH) {
    ShellExecuteW(nullptr, L"open", L"http://127.0.0.1:8788/", nullptr, nullptr, SW_SHOWNORMAL);
  } else if (cmd == IDM_COPY) {
    CopyToClipboard(StatusText());
  } else if (cmd == IDM_EXIT) {
    DestroyWindow(g_hwnd);
  }
}

// ------------------------------------------------------------------ 窗口过程
// 资源管理器崩溃/重启后任务栏会重建、清空所有托盘图标；系统随后广播 TaskbarCreated，
// 收到必须重新 NIM_ADD，否则图标永久消失（本程序靠 WM_CREATE 里注册这个消息）。
static UINT g_taskbarMsg = 0;

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if (g_taskbarMsg && msg == g_taskbarMsg) {
    // 先删再加：真实的 explorer 重启后图标已不存在（DELETE 会失败，无害），
    // 而如果只是模拟广播、图标还在，DELETE+ADD 能保证状态一致。
    if (g_trayShown) {
      TrayRemove();
      TrayAdd();
    }
    return 0;
  }
  switch (msg) {
  case WM_CREATE: {
    g_hwnd = hwnd;
    if (!g_taskbarMsg) g_taskbarMsg = RegisterWindowMessageW(L"TaskbarCreated");
    HDC dc = GetDC(hwnd);
    g_dpi = GetDeviceCaps(dc, LOGPIXELSX);
    ReleaseDC(hwnd, dc);
    if (g_dpi < 96) g_dpi = 96;

    g_fontN = CreateFontW(-MulDiv(9, g_dpi, 72), 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET,
                          OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
    g_fontB = CreateFontW(-MulDiv(10, g_dpi, 72), 0, 0, 0, FW_SEMIBOLD, 0, 0, 0, DEFAULT_CHARSET,
                          OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
    g_fontS = CreateFontW(-MulDiv(8, g_dpi, 72), 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET,
                          OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH, L"Microsoft YaHei UI");
    g_bg = CreateSolidBrush(RGB(252, 252, 253));

    auto mk = [&](const wchar_t* cls, const wchar_t* text, DWORD style, int id, bool bold, bool small) {
      HWND h = CreateWindowExW(0, cls, text, WS_CHILD | WS_VISIBLE | style, 0, 0, 10, 10, hwnd,
                               (HMENU)(INT_PTR)id, g_inst, nullptr);
      SendMessageW(h, WM_SETFONT, (WPARAM)(bold ? g_fontB : small ? g_fontS : g_fontN), TRUE);
      return h;
    };

    for (int i = 0; i < 4; i++) {
      DWORD st = BS_AUTORADIOBUTTON;
      if (i == 0) st |= WS_GROUP | WS_TABSTOP;
      mk(L"BUTTON", MODES[i].label, st, IDC_MODE_BASE + i, false, false);
    }
    mk(L"STATIC", L"当前生效：—", 0, IDC_EFFECTIVE, true, false);
    mk(L"STATIC", L"正在使用：—", 0, IDC_PROVIDER, false, false);
    mk(L"STATIC", L"下次切换：—", 0, IDC_REASON, false, false);
    mk(L"STATIC", L"DeepSeek 高峰：工作日 09:00–12:00、14:00–18:00", 0, IDC_DS_PEAK, false, false);
    mk(L"STATIC", L"Ollama 高峰：工作日 20:00–次日 02:00", 0, IDC_OL_PEAK, false, false);
    mk(L"STATIC", L"DeepSeek 余额：—", 0, IDC_BAL_DS, false, false);
    mk(L"STATIC", L"Ollama 余额：—", 0, IDC_BAL_OL, false, false);
    mk(L"STATIC", L"今天：—", 0, IDC_TODAY, false, false);
    mk(L"BUTTON", L"刷新", BS_PUSHBUTTON | WS_TABSTOP, IDC_REFRESH, false, false);

    HWND chk = mk(L"BUTTON", L"在托盘区显示图标（关闭后就不占托盘）", BS_AUTOCHECKBOX | WS_TABSTOP, IDC_TRAYCHK, false, false);
    SendMessageW(chk, BM_SETCHECK, g_trayShown ? BST_CHECKED : BST_UNCHECKED, 0);
    mk(L"STATIC", L"切换立即生效，不打断正在生成的回答。关闭窗口即缩到托盘，退出用托盘右键菜单。", 0, IDC_FOOTER, false, true);

    Layout();
    RECT rc = { 0, 0, S(470), S(410) };
    AdjustWindowRectEx(&rc, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX, FALSE, 0);
    SetWindowPos(hwnd, nullptr, 0, 0, rc.right - rc.left, rc.bottom - rc.top, SWP_NOMOVE | SWP_NOZORDER);

    g_icon = MakeDotIcon(RGB(140, 148, 158), S(32));
    if (g_icon) {
      SendMessageW(hwnd, WM_SETICON, ICON_BIG, (LPARAM)g_icon);
      SendMessageW(hwnd, WM_SETICON, ICON_SMALL, (LPARAM)g_icon);
    }
    if (g_trayShown) TrayAdd();
    PostRefresh();
    SetTimer(hwnd, TIMER_POLL, 3000, nullptr);
    return 0;
  }
  case WM_COMMAND: {
    int id = LOWORD(wp);
    int code = HIWORD(wp);
    if (id >= IDC_MODE_BASE && id < IDC_MODE_BASE + 4 && code == BN_CLICKED) {
      PostSetMode(MODES[id - IDC_MODE_BASE].key);
      return 0;
    }
    if (id == IDC_TRAYCHK && code == BN_CLICKED) {
      bool on = SendMessageW(GetDlgItem(hwnd, IDC_TRAYCHK), BM_GETCHECK, 0, 0) == BST_CHECKED;
      g_trayShown = on;
      RegSetBool(L"ShowTray", on);
      if (on) TrayAdd(); else TrayRemove();
      return 0;
    }
    if (id == IDC_REFRESH && code == BN_CLICKED) {
      PostRefresh();
      return 0;
    }
    return 0;
  }
  case WM_APP_SNAP: {
    std::string* p = (std::string*)lp;
    ApplySnap(wp == 1, p ? *p : std::string());
    delete p;
    return 0;
  }
  case WM_APP_TRAY: {
    if (LOWORD(lp) == WM_LBUTTONDBLCLK) {
      ShowWindow(hwnd, SW_SHOW);
      SetForegroundWindow(hwnd);
    } else if (LOWORD(lp) == WM_RBUTTONUP || LOWORD(lp) == WM_CONTEXTMENU) {
      ShowTrayMenu();
    }
    return 0;
  }
  case WM_TIMER:
    if (wp == TIMER_POLL) {
      PostRefresh();
      return 0;
    }
    break;
  case WM_SIZE:
    if (wp == SIZE_MINIMIZED && g_trayShown) ShowWindow(hwnd, SW_HIDE);
    return 0;
  case WM_CTLCOLORSTATIC: {
    HDC dc = (HDC)wp;
    int id = GetDlgCtrlID((HWND)lp);
    SetBkColor(dc, RGB(252, 252, 253));
    COLORREF c = RGB(28, 32, 38);
    if (id == IDC_FOOTER) c = RGB(122, 130, 140);
    if (id == IDC_DS_PEAK || id == IDC_OL_PEAK) {
      wchar_t buf[512] = {0};
      GetWindowTextW((HWND)lp, buf, 511);
      c = (wcsstr(buf, L"现在就是")) ? RGB(200, 60, 50) : RGB(122, 130, 140);
    }
    if (id == IDC_EFFECTIVE && !g_reachable) c = RGB(200, 60, 50);
    if (id == IDC_PROVIDER) c = RGB(20, 24, 30);
    SetTextColor(dc, c);
    return (LRESULT)g_bg;
  }
  case WM_ERASEBKGND: {
    RECT rc;
    GetClientRect(hwnd, &rc);
    FillRect((HDC)wp, &rc, g_bg);
    return 1;
  }
  case WM_CLOSE:
    // 有托盘图标时，关闭窗口只是缩到托盘；退出走托盘右键菜单
    if (g_trayShown) {
      ShowWindow(hwnd, SW_HIDE);
      return 0;
    }
    DestroyWindow(hwnd);
    return 0;
  case WM_DESTROY:
    KillTimer(hwnd, TIMER_POLL);
    if (g_trayShown) TrayRemove();
    if (g_icon) DestroyIcon(g_icon);
    if (g_fontN) DeleteObject(g_fontN);
    if (g_fontB) DeleteObject(g_fontB);
    if (g_fontS) DeleteObject(g_fontS);
    if (g_bg) DeleteObject(g_bg);
    PostQuitMessage(0);
    return 0;
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

// ------------------------------------------------------------------ 入口
int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, LPWSTR, int show) {
  g_inst = inst;

  // 高 DPI（Win10 1703+ 才有的 API，动态取）
  typedef BOOL(WINAPI * SetCtxFn)(HANDLE);
  if (HMODULE u = GetModuleHandleW(L"user32.dll")) {
    auto f = (SetCtxFn)GetProcAddress(u, "SetProcessDpiAwarenessContext");
    if (f) f((HANDLE)-4); // PER_MONITOR_AWARE_V2
    else SetProcessDPIAware();
  }

  // 单实例：已经有窗口就把它叫到前面
  HANDLE mutex = CreateMutexW(nullptr, TRUE, L"Local\\OllamaDsRouterTraySingleton");
  if (mutex && GetLastError() == ERROR_ALREADY_EXISTS) {
    if (HWND old = FindWindowW(APP_CLASS, nullptr)) {
      ShowWindow(old, SW_SHOW);
      SetForegroundWindow(old);
    }
    return 0;
  }

  g_trayShown = RegGetBool(L"ShowTray", true);

  WNDCLASSEXW wc = {};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = WndProc;
  wc.hInstance = inst;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = nullptr;
  wc.lpszClassName = APP_CLASS;
  wc.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
  wc.hIconSm = wc.hIcon;
  RegisterClassExW(&wc);

  HWND hwnd = CreateWindowExW(0, APP_CLASS, APP_TITLE, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
                              CW_USEDEFAULT, CW_USEDEFAULT, 500, 460, nullptr, nullptr, inst, nullptr);
  if (!hwnd) return 1;
  // --tray：开机自启时只留托盘不弹窗
  bool startHidden = wcsstr(GetCommandLineW(), L"--tray") != nullptr;
  if (startHidden && g_trayShown) ShowWindow(hwnd, SW_HIDE);
  else ShowWindow(hwnd, show == SW_SHOWMINIMIZED ? SW_SHOWNORMAL : show);
  TrayLog(L"[%lu] start hidden=%d tray=%d show=%d visible=%d\n",
          GetCurrentProcessId(), (int)startHidden, (int)g_trayShown, show, (int)IsWindowVisible(hwnd));
  UpdateWindow(hwnd);

  MSG msg;
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  if (mutex) CloseHandle(mutex);
  return 0;
}
