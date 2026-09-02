; ---------------------------------------------------------------------------
; Dev Launcher NSIS 定制脚本
;
; 防御目标：修复升级安装时报
;   "Failed to uninstall old application files ... : 2"
;
; 根因：升级时新安装器(installSection.nsh)会静默调用旧版卸载器
;   (uninstallOldVersion -> ExecWait)。若 Dev Launcher.exe 及其子进程仍在
;   运行并锁住安装目录，旧卸载器 un.onInit 的默认检测逻辑
;   (_CHECK_APP_RUNNING)在 PowerShell 受限/用户名过滤失效等情况下无法
;   可靠杀掉进程，静默模式下自动选"取消"并 Quit，退出码 2，升级中断。
;
; 防御策略（三个钩子，均为安装器/卸载器早期阶段）：
;   1. customCheckAppRunning — 完全替换 electron-builder 默认的
;      "检测 + WM_CLOSE + 重试 + Quit"逻辑，改为直接 taskkill /F /T
;      强杀进程树后放行。生效于：安装/升级开始前(installSection)、
;      卸载器静默模式(未来版本间升级时被新安装器调用)。
;   2. customInit — 新安装器 .onInit 最早期再杀一次，确保随后被调用的
;      旧版卸载器（其代码无法修改）运行时目录已无句柄占用。
;      同时覆盖 assisted 安装器 UAC 内部实例跳过 CHECK_APP_RUNNING 的缺口。
;   3. customUnInit — 卸载器 un.onInit 无条件钩子，兜住交互式（非静默）
;      卸载不走 checkAppRunning 的场景。
;
; 说明：taskkill 无匹配进程时返回 128，无需判断退出码；
;       /T 连同 Electron 子进程（GPU/Utility 等）整树终止。
; ---------------------------------------------------------------------------

!macro killAppProcessTree
  nsExec::ExecToLog `"$SYSDIR\taskkill.exe" /F /T /IM "Dev Launcher.exe"`
  Pop $0
!macroend

!macro customCheckAppRunning
  !insertmacro killAppProcessTree
  Sleep 800
!macroend

!macro customInit
  !insertmacro killAppProcessTree
  Sleep 800
!macroend

!macro customUnInit
  !insertmacro killAppProcessTree
  Sleep 800
!macroend

!macro customInstall
  ; Recreate shortcuts on every install/update and point them to the real ICO
  ; file. assets/icon.ico is unpacked from the asar (see asarUnpack in
  ; package.json) and lives on disk under app.asar.unpacked, not under
  ; resources/app — pointing the .lnk at a virtual path would produce a broken
  ; shortcut icon in Windows.
  Delete "$DESKTOP\Dev Launcher.lnk"
  Delete "$SMPROGRAMS\Dev Launcher.lnk"
  CreateShortCut "$DESKTOP\Dev Launcher.lnk" "$INSTDIR\Dev Launcher.exe" "" "$INSTDIR\resources\app.asar.unpacked\assets\icon.ico" 0 SW_SHOWNORMAL "" "Dev Launcher"
  CreateShortCut "$SMPROGRAMS\Dev Launcher.lnk" "$INSTDIR\Dev Launcher.exe" "" "$INSTDIR\resources\app.asar.unpacked\assets\icon.ico" 0 SW_SHOWNORMAL "" "Dev Launcher"
!macroend

!macro customUnInstall
  Delete "$DESKTOP\Dev Launcher.lnk"
  Delete "$SMPROGRAMS\Dev Launcher.lnk"
!macroend
