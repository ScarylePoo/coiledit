; CoilEdit Windows integration (current user only).
;
; CoilEdit never makes itself the default program for a file type. It registers a
; ProgID, lists itself under "Open with" for common code/text types, and adds
; "Edit with CoilEdit" to every file's right-click menu. Picking CoilEdit as the
; default is left to the user (Open with -> Always).
;
; It also repairs v0.2.0, whose installer set CoilEdit as the default for every type
; it listed (including .bat, .py and .js, which then stopped running on double-click).

!define COILEDIT_PROGID "CoilEdit File"

!macro CoilEditForEachExt _M
  !insertmacro ${_M} lua
  !insertmacro ${_M} txt
  !insertmacro ${_M} md
  !insertmacro ${_M} json
  !insertmacro ${_M} js
  !insertmacro ${_M} ts
  !insertmacro ${_M} css
  !insertmacro ${_M} html
  !insertmacro ${_M} xml
  !insertmacro ${_M} ini
  !insertmacro ${_M} cfg
  !insertmacro ${_M} glsl
  !insertmacro ${_M} vert
  !insertmacro ${_M} frag
  !insertmacro ${_M} sh
  !insertmacro ${_M} bat
  !insertmacro ${_M} cmd
  !insertmacro ${_M} ps1
  !insertmacro ${_M} py
  !insertmacro ${_M} c
  !insertmacro ${_M} cpp
  !insertmacro ${_M} h
  !insertmacro ${_M} hpp
  !insertmacro ${_M} yml
  !insertmacro ${_M} yaml
  !insertmacro ${_M} toml
  !insertmacro ${_M} log
  !insertmacro ${_M} tdf
  !insertmacro ${_M} fbi
  !insertmacro ${_M} bos
!macroend

; Add to "Open with" without touching the default program.
!macro CoilEditOpenWith EXT
  WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${COILEDIT_PROGID}" ""
!macroend

!macro CoilEditRemoveOpenWith EXT
  DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "${COILEDIT_PROGID}"
!macroend

; Undo the v0.2.0 takeover: restore the previous default it backed up.
!macro CoilEditRepairExt EXT
  ClearErrors
  ReadRegStr $R1 HKCU "Software\Classes\.${EXT}" "${COILEDIT_PROGID}_backup"
  IfErrors coiledit_repair_done_${EXT}
  ReadRegStr $R0 HKCU "Software\Classes\.${EXT}" ""
  StrCmp $R0 "${COILEDIT_PROGID}" coiledit_repair_restore_${EXT}
  StrCmp $R0 "" coiledit_repair_restore_${EXT}
  Goto coiledit_repair_cleanup_${EXT}
  coiledit_repair_restore_${EXT}:
    StrCmp $R1 "" 0 +3
      DeleteRegValue HKCU "Software\Classes\.${EXT}" ""
      Goto coiledit_repair_cleanup_${EXT}
    WriteRegStr HKCU "Software\Classes\.${EXT}" "" "$R1"
  coiledit_repair_cleanup_${EXT}:
    DeleteRegValue HKCU "Software\Classes\.${EXT}" "${COILEDIT_PROGID}_backup"
  coiledit_repair_done_${EXT}:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro CoilEditForEachExt CoilEditRepairExt

  ; The ProgID that "Open with" (and a user's own default choice) points at.
  WriteRegStr HKCU "Software\Classes\${COILEDIT_PROGID}" "" "Code file"
  WriteRegStr HKCU "Software\Classes\${COILEDIT_PROGID}\DefaultIcon" "" '"$INSTDIR\${MAINBINARYNAME}.exe",0'
  WriteRegStr HKCU "Software\Classes\${COILEDIT_PROGID}\shell" "" "open"
  WriteRegStr HKCU "Software\Classes\${COILEDIT_PROGID}\shell\open" "" "Open with CoilEdit"
  WriteRegStr HKCU "Software\Classes\${COILEDIT_PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  !insertmacro CoilEditForEachExt CoilEditOpenWith

  ; "Edit with CoilEdit" on every file's right-click menu
  WriteRegStr HKCU "Software\Classes\*\shell\CoilEdit" "" "Edit with CoilEdit"
  WriteRegStr HKCU "Software\Classes\*\shell\CoilEdit" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\CoilEdit\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro CoilEditForEachExt CoilEditRemoveOpenWith
  DeleteRegKey HKCU "Software\Classes\${COILEDIT_PROGID}"
  DeleteRegKey HKCU "Software\Classes\*\shell\CoilEdit"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
