; Cursor 一键汉化 Windows 安装包（按用户安装，不需要管理员）
; 由 scripts/build-desktop.mjs --win 调用 makensis 生成，参数：/DVERSION /DSRCDIR（win-unpacked）/DOUTFILE
Unicode true
ManifestDPIAware true
SetCompressor /SOLID lzma
RequestExecutionLevel user

!define APPNAME "Cursor 一键汉化"
!define EXENAME "cursor-zh-localizer.exe"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\cursor-zh-localizer"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\cursor-zh-localizer"
InstallDirRegKey HKCU "${REGKEY}" "InstallLocation"
BrandingText "${APPNAME} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=2052 "FileDescription" "${APPNAME} 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "CompanyName" "cursor-zh-localizer"
VIAddVersionKey /LANG=2052 "LegalCopyright" "MIT"

!include "MUI2.nsh"
!define MUI_ABORTWARNING
!ifdef ICON
!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!endif
!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXENAME}"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 ${APPNAME}"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Install"
  ; 覆盖安装前先关掉正在运行的本工具
  nsExec::Exec 'taskkill /F /IM ${EXENAME}'
  SetOutPath "$INSTDIR"
  File /r "${SRCDIR}\*.*"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateShortCut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${EXENAME}"
  CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXENAME}"
  WriteRegStr HKCU "${REGKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${REGKEY}" "Publisher" "cursor-zh-localizer"
  WriteRegStr HKCU "${REGKEY}" "DisplayIcon" "$INSTDIR\${EXENAME}"
  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1
SectionEnd

Function un.onInit
  MessageBox MB_OKCANCEL|MB_ICONINFORMATION "卸载本工具不会还原 Cursor 的汉化。$\r$\n如需恢复英文界面，请先在本工具里点「还原」，再卸载。$\r$\n$\r$\n继续卸载？" IDOK +2
  Abort
FunctionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM ${EXENAME}'
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${REGKEY}"
  ; 备份和状态（%APPDATA%\cursor-zh-localizer）保留，用于以后还原
SectionEnd
