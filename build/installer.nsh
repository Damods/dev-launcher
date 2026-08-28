!macro customInstall
  ; Recreate shortcuts on every install/update and point them to the real ICO
  ; file. This avoids relying on executable resource editing, which is disabled
  ; for compatibility on some Windows systems.
  Delete "$DESKTOP\Dev Launcher.lnk"
  Delete "$SMPROGRAMS\Dev Launcher.lnk"
  CreateShortCut "$DESKTOP\Dev Launcher.lnk" "$INSTDIR\Dev Launcher.exe" "" "$INSTDIR\resources\app\assets\icon.ico" 0 SW_SHOWNORMAL "" "Dev Launcher"
  CreateShortCut "$SMPROGRAMS\Dev Launcher.lnk" "$INSTDIR\Dev Launcher.exe" "" "$INSTDIR\resources\app\assets\icon.ico" 0 SW_SHOWNORMAL "" "Dev Launcher"
!macroend

!macro customUnInstall
  Delete "$DESKTOP\Dev Launcher.lnk"
  Delete "$SMPROGRAMS\Dev Launcher.lnk"
!macroend
