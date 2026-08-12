Unicode true
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required"
!endif
!ifndef APP_ARCHIVE
  !error "APP_ARCHIVE is required"
!endif
!ifndef UNINSTALLER_FILE
  !error "UNINSTALLER_FILE is required"
!endif
!ifndef SEVEN_ZIP_FILE
  !error "SEVEN_ZIP_FILE is required"
!endif
!ifndef APP_VERSION
  !error "APP_VERSION is required"
!endif
!ifndef ESTIMATED_SIZE
  !error "ESTIMATED_SIZE is required"
!endif

!define OWNERSHIP_MARKER ".haksulsomoim-smallfraud-owned"
Name "소액사기 사건 코파일럿"
OutFile "${OUTPUT_FILE}"
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\HaksulSomoimSmallFraudAgent"
SetCompress off
ShowInstDetails show

!include "MUI2.nsh"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\haksulsomoim-small-fraud-agent.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "Korean"
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetShellVarContext current
  SetRegView 64
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\HaksulSomoimSmallFraudAgent"
  StrCpy $R8 "$INSTDIR.installing"
  StrCpy $R9 "$INSTDIR.previous"
  StrCpy $R7 "0"

  IfFileExists "$INSTDIR\." 0 inspect_staging
    IfFileExists "$INSTDIR\${OWNERSHIP_MARKER}" owned_install foreign_install
  owned_install:
    StrCpy $R7 "1"

  inspect_staging:
  IfFileExists "$R8\." 0 inspect_previous
    IfFileExists "$R8\${OWNERSHIP_MARKER}" remove_staging foreign_staging
  remove_staging:
    RMDir /r "$R8"
    IfFileExists "$R8\." cleanup_failed

  inspect_previous:
  IfFileExists "$R9\." 0 create_staging
    IfFileExists "$R9\${OWNERSHIP_MARKER}" recover_previous foreign_previous
  recover_previous:
    StrCmp $R7 "1" create_staging
    ClearErrors
    Rename "$R9" "$INSTDIR"
    IfErrors previous_recovery_failed
    StrCpy $R7 "1"

  create_staging:
  CreateDirectory "$R8"
  ClearErrors
  FileOpen $R0 "$R8\${OWNERSHIP_MARKER}" w
  IfErrors staging_create_failed
  FileWrite $R0 "kr.co.haksulsomoim.smallfraud$\r$\n"
  FileClose $R0

  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=app-x64.7z "${APP_ARCHIVE}"
  File /oname=7za.exe "${SEVEN_ZIP_FILE}"
  nsExec::ExecToStack '"$PLUGINSDIR\7za.exe" x "$PLUGINSDIR\app-x64.7z" "-o$R8" -y'
  Pop $R1
  Pop $R0
  StrCmp $R1 "0" extraction_succeeded extraction_failed

  extraction_succeeded:
  IfFileExists "$R8\haksulsomoim-small-fraud-agent.exe" 0 extraction_failed
  IfFileExists "$R8\resources\." 0 extraction_failed
  IfFileExists "$R8\resources\app.asar" payload_valid extraction_failed

  payload_valid:
  IfFileExists "$R9\." 0 write_uninstaller
    IfFileExists "$R9\${OWNERSHIP_MARKER}" remove_previous foreign_previous
  remove_previous:
    RMDir /r "$R9"
    IfFileExists "$R9\." cleanup_failed

  write_uninstaller:
  ClearErrors
  SetOutPath "$R8"
  File /oname=uninstall.exe "${UNINSTALLER_FILE}"
  IfErrors extraction_failed

  StrCmp $R7 "1" replace_existing replace_staged
  replace_existing:
    ClearErrors
    Rename "$INSTDIR" "$R9"
    IfErrors replacement_failed

  replace_staged:
    ClearErrors
    Rename "$R8" "$INSTDIR"
    IfErrors replacement_failed
    StrCmp $R7 "1" remove_replaced_install registration

  remove_replaced_install:
    IfFileExists "$R9\${OWNERSHIP_MARKER}" 0 registration
    RMDir /r "$R9"

  registration:
  CreateShortcut "$DESKTOP\소액사기 사건 코파일럿.lnk" "$INSTDIR\haksulsomoim-small-fraud-agent.exe"
  CreateShortcut "$SMPROGRAMS\소액사기 사건 코파일럿.lnk" "$INSTDIR\haksulsomoim-small-fraud-agent.exe"
  WriteRegStr HKCU "Software\kr.co.haksulsomoim.smallfraud" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\kr.co.haksulsomoim.smallfraud" "DisplayName" "소액사기 사건 코파일럿"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\kr.co.haksulsomoim.smallfraud" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\kr.co.haksulsomoim.smallfraud" "Publisher" "Haksul Somoim"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\kr.co.haksulsomoim.smallfraud" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\kr.co.haksulsomoim.smallfraud" "DisplayIcon" "$INSTDIR\haksulsomoim-small-fraud-agent.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\kr.co.haksulsomoim.smallfraud" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\kr.co.haksulsomoim.smallfraud" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\kr.co.haksulsomoim.smallfraud" "NoRepair" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\kr.co.haksulsomoim.smallfraud" "EstimatedSize" ${ESTIMATED_SIZE}
  Goto install_done

  replacement_failed:
    StrCmp $R7 "1" 0 cleanup_failed_stage
    IfFileExists "$INSTDIR\." cleanup_failed_stage
    ClearErrors
    Rename "$R9" "$INSTDIR"
    IfErrors rollback_failed
    Goto cleanup_failed_stage
  rollback_failed:
    IfFileExists "$R8\${OWNERSHIP_MARKER}" 0 rollback_abort
    RMDir /r "$R8"
  rollback_abort:
    MessageBox MB_OK|MB_ICONSTOP "치명적 오류: 기존 설치가 복원되지 않았습니다. 이전 설치는 $R9에 남아 있습니다."
    Abort
  cleanup_failed_stage:
    IfFileExists "$R8\${OWNERSHIP_MARKER}" 0 replacement_abort
    RMDir /r "$R8"
  replacement_abort:
    MessageBox MB_OK|MB_ICONSTOP "기존 설치를 안전하게 교체하지 못했습니다."
    Abort

  extraction_failed:
    IfFileExists "$R8\${OWNERSHIP_MARKER}" 0 extraction_abort
    RMDir /r "$R8"
  extraction_abort:
    MessageBox MB_OK|MB_ICONSTOP "완전한 앱 파일을 추출하지 못했습니다. 기존 설치는 변경하지 않았습니다."
    Abort

  staging_create_failed:
    MessageBox MB_OK|MB_ICONSTOP "안전한 임시 설치 폴더를 만들지 못했습니다."
    Abort
  cleanup_failed:
    MessageBox MB_OK|MB_ICONSTOP "이전 임시 설치 폴더를 안전하게 정리하지 못했습니다."
    Abort
  foreign_install:
    MessageBox MB_OK|MB_ICONSTOP "설치 폴더가 이 제품의 소유로 확인되지 않아 변경하지 않습니다."
    Abort
  foreign_staging:
    MessageBox MB_OK|MB_ICONSTOP "임시 설치 폴더가 이 제품의 소유로 확인되지 않아 변경하지 않습니다."
    Abort
  foreign_previous:
    MessageBox MB_OK|MB_ICONSTOP "이전 설치 폴더가 이 제품의 소유로 확인되지 않아 변경하지 않습니다."
    Abort
  previous_recovery_failed:
    MessageBox MB_OK|MB_ICONSTOP "중단된 이전 설치를 복원하지 못했습니다. $INSTDIR.previous 폴더를 보존했습니다."
    Abort
  install_done:
SectionEnd
