; "Edit with CoilEdit" on the right-click menu of every file (current user only)
!macro customInstall
  WriteRegStr HKCU "Software\Classes\*\shell\CoilEdit" "" "Edit with CoilEdit"
  WriteRegStr HKCU "Software\Classes\*\shell\CoilEdit" "Icon" "$INSTDIR\CoilEdit.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\CoilEdit\command" "" '"$INSTDIR\CoilEdit.exe" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\*\shell\CoilEdit"
!macroend
