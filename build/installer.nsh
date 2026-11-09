; 自定义卸载：只删本应用自己的程序文件
;
; 两个教训写在这里：
; 1) 默认 NSIS 卸载器会 RMDir /r $INSTDIR，如果用户装到已有其他软件的公共目录，
;    会把邻居一起删掉 —— 所以这里只删登记过的文件，最后用不带 /r 的 RMDir。
; 2) 升级时 NSIS 会先调用旧版卸载器，如果卸载器删 payload，升级就会把 14GB 运行环境清空
;    —— 所以 payload 一律不删，留给用户；真要清理请在应用里或手动删除安装目录下的 payload。

!macro customRemoveFiles
  DetailPrint "移除 声匠 VoiceSmith 程序文件（保留 payload 运行环境）…"

  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"

  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\*.html"
  Delete "$INSTDIR\*.txt"
  Delete "$INSTDIR\VoiceSmith.exe"

  ; 目录非空则保留（payload 还在时这里不会删掉整个目录）
  RMDir "$INSTDIR"
!macroend
