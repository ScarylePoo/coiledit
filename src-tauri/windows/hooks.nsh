; "Edit with CoilEdit" on the right-click menu of every file (current user only)
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\*\shell\CoilEdit" "" "Edit with CoilEdit"
  WriteRegStr HKCU "Software\Classes\*\shell\CoilEdit" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\CoilEdit\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\*\shell\CoilEdit"
!macroend
