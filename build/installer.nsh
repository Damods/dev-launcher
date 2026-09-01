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
