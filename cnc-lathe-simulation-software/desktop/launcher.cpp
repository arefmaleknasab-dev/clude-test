/*
 * KharraatCode Native Windows 10 Offline Desktop Launcher (x86_64 Win32 GUI)
 * - 100% offline: uses only 127.0.0.1 kernel loopback (zero internet needed)
 * - Serves external KharraatCode-Offline.html if placed beside the .exe, or
 *   falls back to the embedded gzipped payload compiled directly into the .exe
 * - Opens a frameless standalone desktop app window using Edge/Chrome/Brave
 *   with an isolated persistent profile in %LOCALAPPDATA%\KharraatCode
 */

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <shellapi.h>

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>
#include <vector>

#include "embedded_app.h"

static constexpr int BASE_PORT = 45820;
static constexpr int MAX_PORT_TRIES = 16;

static std::vector<uint8_t> g_externalHtml;
static std::atomic<ULONGLONG> g_lastActivityTick{0};
static std::atomic<bool> g_clientEverConnected{false};
static std::atomic<int> g_openSessions{0};
static std::atomic<ULONGLONG> g_lastCloseTick{0};
static std::atomic<int> g_activeRequests{0};

static bool fileExistsW(const std::wstring& path) {
  DWORD attr = GetFileAttributesW(path.c_str());
  return attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

static std::wstring getEnvW(const wchar_t* name) {
  wchar_t buf[32768];
  DWORD n = GetEnvironmentVariableW(name, buf, 32768);
  return (n > 0 && n < 32768) ? std::wstring(buf, n) : L"";
}

static std::wstring getExeDir() {
  wchar_t buf[MAX_PATH * 4];
  DWORD len = GetModuleFileNameW(nullptr, buf, MAX_PATH * 4);
  if (len == 0) return L".";
  std::wstring full(buf, len);
  size_t pos = full.find_last_of(L"\\/");
  return (pos == std::wstring::npos) ? L"." : full.substr(0, pos);
}

static void ensureDirRecursive(const std::wstring& dir) {
  if (dir.empty()) return;
  size_t pos = 0;
  while ((pos = dir.find_first_of(L"\\/", pos + 1)) != std::wstring::npos) {
    std::wstring sub = dir.substr(0, pos);
    if (sub.size() > 2 && sub.back() != L':') {
      CreateDirectoryW(sub.c_str(), nullptr);
    }
  }
  CreateDirectoryW(dir.c_str(), nullptr);
}

static void loadAdjacentHtmlIfPresent() {
  std::wstring candidate = getExeDir() + L"\\KharraatCode-Offline.html";
  HANDLE h = CreateFileW(candidate.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (h == INVALID_HANDLE_VALUE) return;
  LARGE_INTEGER sz{};
  if (GetFileSizeEx(h, &sz) && sz.QuadPart > 1024 && sz.QuadPart < (64LL * 1024 * 1024)) {
    g_externalHtml.resize(static_cast<size_t>(sz.QuadPart));
    DWORD readBytes = 0;
    if (!ReadFile(h, g_externalHtml.data(), static_cast<DWORD>(g_externalHtml.size()), &readBytes, nullptr) ||
        readBytes != g_externalHtml.size()) {
      g_externalHtml.clear();
    }
  }
  CloseHandle(h);
}

static std::wstring queryAppPathReg(HKEY root, const wchar_t* exeName) {
  std::wstring subKey = std::wstring(L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\") + exeName;
  HKEY hKey = nullptr;
  if (RegOpenKeyExW(root, subKey.c_str(), 0, KEY_READ, &hKey) != ERROR_SUCCESS) return L"";
  wchar_t val[MAX_PATH * 2];
  DWORD valSize = sizeof(val);
  DWORD type = 0;
  std::wstring res;
  if (RegQueryValueExW(hKey, nullptr, nullptr, &type, reinterpret_cast<LPBYTE>(val), &valSize) == ERROR_SUCCESS &&
      (type == REG_SZ || type == REG_EXPAND_SZ)) {
    wchar_t expanded[MAX_PATH * 2];
    DWORD expLen = ExpandEnvironmentStringsW(val, expanded, MAX_PATH * 2);
    if (expLen > 0 && expLen < MAX_PATH * 2) res = expanded;
    else res = val;
  }
  RegCloseKey(hKey);
  if (!res.empty() && res.front() == L'"' && res.back() == L'"' && res.size() >= 2) {
    res = res.substr(1, res.size() - 2);
  }
  return fileExistsW(res) ? res : L"";
}

static std::wstring findChromiumBrowser() {
  const wchar_t* appNames[] = { L"msedge.exe", L"chrome.exe", L"brave.exe" };
  for (const wchar_t* name : appNames) {
    std::wstring p = queryAppPathReg(HKEY_CURRENT_USER, name);
    if (!p.empty()) return p;
    p = queryAppPathReg(HKEY_LOCAL_MACHINE, name);
    if (!p.empty()) return p;
  }

  std::wstring pf86 = getEnvW(L"ProgramFiles(x86)");
  std::wstring pf   = getEnvW(L"ProgramFiles");
  std::wstring lad  = getEnvW(L"LOCALAPPDATA");

  std::vector<std::wstring> paths = {
    pf86 + L"\\Microsoft\\Edge\\Application\\msedge.exe",
    pf   + L"\\Microsoft\\Edge\\Application\\msedge.exe",
    lad  + L"\\Microsoft\\Edge\\Application\\msedge.exe",
    pf   + L"\\Google\\Chrome\\Application\\chrome.exe",
    pf86 + L"\\Google\\Chrome\\Application\\chrome.exe",
    lad  + L"\\Google\\Chrome\\Application\\chrome.exe",
    pf   + L"\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    pf86 + L"\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    lad  + L"\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  };
  for (const auto& c : paths) {
    if (!c.empty() && fileExistsW(c)) return c;
  }
  return L"";
}

static HANDLE launchDesktopWindow(int port) {
  wchar_t urlBuf[128];
  std::swprintf(urlBuf, 128, L"http://127.0.0.1:%d/", port);
  std::wstring url(urlBuf);

  std::wstring browser = findChromiumBrowser();
  if (!browser.empty()) {
    std::wstring baseDataDir = getEnvW(L"LOCALAPPDATA");
    if (baseDataDir.empty()) baseDataDir = getExeDir();
    std::wstring profileDir = baseDataDir + L"\\KharraatCode\\DesktopProfile";
    ensureDirRecursive(profileDir);

    std::wstring cmd = L"\"" + browser + L"\""
      + L" --app=" + url
      + L" --user-data-dir=\"" + profileDir + L"\""
      + L" --window-size=1440,900"
      + L" --no-first-run"
      + L" --no-default-browser-check"
      + L" --disable-background-mode"
      + L" --disable-sync"
      + L" --overscroll-history-navigation=0"
      + L" --disable-background-timer-throttling"
      + L" --disable-renderer-backgrounding"
      + L" --disable-features=Translate,msEdgeSidebarV2,EdgeCollections,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling";

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    std::vector<wchar_t> mutableCmd(cmd.begin(), cmd.end());
    mutableCmd.push_back(L'\0');

    if (CreateProcessW(browser.c_str(), mutableCmd.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) {
      CloseHandle(pi.hThread);
      return pi.hProcess;
    }
  }

  ShellExecuteW(nullptr, L"open", url.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
  return nullptr;
}

static bool checkRunningInstance(int port) {
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == INVALID_SOCKET) return false;
  DWORD timeoutMs = 250;
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeoutMs), sizeof(timeoutMs));
  setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeoutMs), sizeof(timeoutMs));

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = htons(static_cast<u_short>(port));

  bool ok = false;
  if (connect(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0) {
    const char* req = "GET /__health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    send(s, req, static_cast<int>(std::strlen(req)), 0);
    char buf[256]{};
    int n = recv(s, buf, sizeof(buf) - 1, 0);
    if (n > 0 && std::strstr(buf, "KharraatCode-Desktop-OK") != nullptr) {
      ok = true;
    }
  }
  closesocket(s);
  return ok;
}

static int findRunningInstancePort() {
  for (int i = 0; i < MAX_PORT_TRIES; ++i) {
    int p = BASE_PORT + i;
    if (checkRunningInstance(p)) return p;
  }
  return -1;
}

static void sendAll(SOCKET c, const char* data, size_t len) {
  size_t off = 0;
  while (off < len) {
    int chunk = static_cast<int>((len - off) > 65536 ? 65536 : (len - off));
    int sent = send(c, data + off, chunk, 0);
    if (sent <= 0) break;
    off += static_cast<size_t>(sent);
  }
}

struct ActiveRequestGuard {
  ~ActiveRequestGuard() {
    g_activeRequests.fetch_sub(1);
  }
};

static void handleClient(SOCKET client) {
  ActiveRequestGuard reqGuard;
  DWORD timeoutMs = 8000;
  setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char*>(&timeoutMs), sizeof(timeoutMs));
  setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char*>(&timeoutMs), sizeof(timeoutMs));

  char req[4096]{};
  int n = recv(client, req, sizeof(req) - 1, 0);
  if (n <= 0) {
    closesocket(client);
    return;
  }

  std::string firstLine(req, static_cast<size_t>(n));
  size_t lineEnd = firstLine.find("\r\n");
  if (lineEnd != std::string::npos) firstLine.resize(lineEnd);

  std::string path = "/";
  size_t sp1 = firstLine.find(' ');
  if (sp1 != std::string::npos) {
    size_t sp2 = firstLine.find(' ', sp1 + 1);
    path = (sp2 != std::string::npos) ? firstLine.substr(sp1 + 1, sp2 - sp1 - 1) : firstLine.substr(sp1 + 1);
  }
  size_t qpos = path.find('?');
  if (qpos != std::string::npos) path.resize(qpos);

  ULONGLONG now = GetTickCount64();

  if (path == "/__health") {
    g_lastCloseTick.store(0);
    g_lastActivityTick.store(now);
    const char* body = "KharraatCode-Desktop-OK";
    char hdr[256];
    int hlen = std::snprintf(
      hdr, sizeof(hdr),
      "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %zu\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
      std::strlen(body)
    );
    sendAll(client, hdr, static_cast<size_t>(hlen));
    sendAll(client, body, std::strlen(body));
    closesocket(client);
    return;
  }

  if (path == "/__open") {
    g_clientEverConnected.store(true);
    g_openSessions.fetch_add(1);
    g_lastCloseTick.store(0);
    g_lastActivityTick.store(now);
    const char* resp = "HTTP/1.1 204 No Content\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
    sendAll(client, resp, std::strlen(resp));
    closesocket(client);
    return;
  }

  if (path == "/__ping") {
    g_clientEverConnected.store(true);
    g_lastCloseTick.store(0);
    g_lastActivityTick.store(now);
    const char* resp = "HTTP/1.1 204 No Content\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
    sendAll(client, resp, std::strlen(resp));
    closesocket(client);
    return;
  }

  if (path == "/__close") {
    int rem = g_openSessions.fetch_sub(1) - 1;
    if (rem <= 0) {
      g_openSessions.store(0);
      g_lastCloseTick.store(now);
    }
    const char* resp = "HTTP/1.1 204 No Content\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
    sendAll(client, resp, std::strlen(resp));
    closesocket(client);
    return;
  }

  if (path == "/favicon.ico") {
    char hdr[256];
    int hlen = std::snprintf(
      hdr, sizeof(hdr),
      "HTTP/1.1 200 OK\r\nContent-Type: image/x-icon\r\nContent-Length: %zu\r\nCache-Control: public, max-age=86400\r\nConnection: close\r\n\r\n",
      EMBEDDED_ICON_ICO_LEN
    );
    sendAll(client, hdr, static_cast<size_t>(hlen));
    sendAll(client, reinterpret_cast<const char*>(EMBEDDED_ICON_ICO), EMBEDDED_ICON_ICO_LEN);
    closesocket(client);
    return;
  }

  // Main application HTML
  g_clientEverConnected.store(true);
  g_lastCloseTick.store(0);
  g_lastActivityTick.store(now);

  if (!g_externalHtml.empty()) {
    char hdr[320];
    int hlen = std::snprintf(
      hdr, sizeof(hdr),
      "HTTP/1.1 200 OK\r\n"
      "Content-Type: text/html; charset=utf-8\r\n"
      "Content-Length: %zu\r\n"
      "Cache-Control: no-store\r\n"
      "X-Content-Type-Options: nosniff\r\n"
      "Connection: close\r\n\r\n",
      g_externalHtml.size()
    );
    sendAll(client, hdr, static_cast<size_t>(hlen));
    sendAll(client, reinterpret_cast<const char*>(g_externalHtml.data()), g_externalHtml.size());
  } else {
    char hdr[360];
    int hlen = std::snprintf(
      hdr, sizeof(hdr),
      "HTTP/1.1 200 OK\r\n"
      "Content-Type: text/html; charset=utf-8\r\n"
      "Content-Encoding: gzip\r\n"
      "Content-Length: %zu\r\n"
      "Cache-Control: no-store\r\n"
      "X-Content-Type-Options: nosniff\r\n"
      "Connection: close\r\n\r\n",
      EMBEDDED_APP_GZ_LEN
    );
    sendAll(client, hdr, static_cast<size_t>(hlen));
    sendAll(client, reinterpret_cast<const char*>(EMBEDDED_APP_GZ), EMBEDDED_APP_GZ_LEN);
  }
  closesocket(client);
}

int WINAPI WinMain(HINSTANCE, HINSTANCE, LPSTR, int) {
  WSADATA wsa{};
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    MessageBoxW(nullptr, L"خطا در راه‌اندازی شبکه محلی ویندوز (WinSock).", L"خراط‌کد", MB_ICONERROR | MB_OK);
    return 1;
  }

  int runningPort = findRunningInstancePort();
  if (runningPort > 0) {
    HANDLE h = launchDesktopWindow(runningPort);
    if (h) CloseHandle(h);
    WSACleanup();
    return 0;
  }

  loadAdjacentHtmlIfPresent();

  SOCKET listenSock = INVALID_SOCKET;
  int boundPort = -1;

  for (int i = 0; i < MAX_PORT_TRIES; ++i) {
    int p = BASE_PORT + i;
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) continue;

    BOOL excl = TRUE;
    setsockopt(s, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char*>(&excl), sizeof(excl));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(static_cast<u_short>(p));

    if (bind(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) == 0 && listen(s, SOMAXCONN) == 0) {
      listenSock = s;
      boundPort = p;
      break;
    }
    closesocket(s);
  }

  if (listenSock == INVALID_SOCKET) {
    MessageBoxW(nullptr, L"امکان ایجاد درگاه محلی (127.0.0.1) وجود ندارد.", L"خراط‌کد", MB_ICONERROR | MB_OK);
    WSACleanup();
    return 1;
  }

  ULONGLONG startTick = GetTickCount64();
  g_lastActivityTick.store(startTick);

  HANDLE childProc = launchDesktopWindow(boundPort);

  while (true) {
    fd_set readSet;
    FD_ZERO(&readSet);
    FD_SET(listenSock, &readSet);
    timeval tv{ 0, 250000 }; // 250ms poll

    int sel = select(0, &readSet, nullptr, nullptr, &tv);
    if (sel > 0 && FD_ISSET(listenSock, &readSet)) {
      SOCKET client = accept(listenSock, nullptr, nullptr);
      if (client != INVALID_SOCKET) {
        g_activeRequests.fetch_add(1);
        g_lastCloseTick.store(0);
        g_lastActivityTick.store(GetTickCount64());
        std::thread(handleClient, client).detach();
      }
    }

    if (g_activeRequests.load() > 0) {
      continue;
    }

    ULONGLONG now = GetTickCount64();
    bool childExited = false;
    if (childProc != nullptr) {
      if (WaitForSingleObject(childProc, 0) == WAIT_OBJECT_0) {
        childExited = true;
      }
    }

    if (!g_clientEverConnected.load()) {
      // Allow up to 90 seconds for slow HDD cold-start on Windows 10
      if (now - startTick > 90000) break;
    } else {
      ULONGLONG closeTick = g_lastCloseTick.load();
      if (closeTick != 0 && g_openSessions.load() <= 0 && (now - closeTick > 8000)) {
        break;
      }
      // Fallback: if browser crashed without sendBeacon and no ping for 10 minutes
      if ((childProc == nullptr || childExited) && (now - g_lastActivityTick.load() > 600000)) {
        break;
      }
    }
  }

  if (childProc != nullptr) CloseHandle(childProc);
  closesocket(listenSock);
  WSACleanup();
  return 0;
}
