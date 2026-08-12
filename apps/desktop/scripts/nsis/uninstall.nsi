Unicode true
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required"
!endif

!define OWNERSHIP_MARKER ".haksulsomoim-smallfraud-owned"
Name "소액사기 사건 코파일럿"
OutFile "${OUTPUT_FILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\HaksulSomoimSmallFraudAgent"
SilentInstall normal
ShowInstDetails show

Section
  SetShellVarContext current
  SetRegView 64
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\HaksulSomoimSmallFraudAgent"
  IfFileExists "$INSTDIR\${OWNERSHIP_MARKER}" owned_install foreign_install

  foreign_install:
    MessageBox MB_OK|MB_ICONSTOP "설치 폴더가 이 제품의 소유로 확인되지 않아 제거하지 않습니다."
    Abort

  owned_install:
  Delete "$DESKTOP\소액사기 사건 코파일럿.lnk"
  Delete "$SMPROGRAMS\소액사기 사건 코파일럿.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\kr.co.haksulsomoim.smallfraud"
  DeleteRegKey HKCU "Software\kr.co.haksulsomoim.smallfraud"
  RMDir /r "$INSTDIR"
  Delete /REBOOTOK "$INSTDIR\uninstall.exe"
  RMDir /REBOOTOK "$INSTDIR"
SectionEnd
