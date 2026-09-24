@echo off
rem peer.cmd - operate a paired machine from the command line (local DSH closed;
rem the peer machine's DSH must be running). ASCII only: cmd.exe parses ANSI.
rem usage: peer status | peer ask "..." | peer ls | peer read <file> | peer pull <remote> <local> | peer push <local>
node "%~dp0scripts\peer.mjs" %*
