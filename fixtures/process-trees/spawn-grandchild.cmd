@echo off
rem PRD §14.6, RT-001: the Windows twin of spawn-grandchild.sh.
rem
rem The runtime's non-unix path uses `taskkill /PID <pid> /T`, which walks the tree via
rem the parent-PID table. A direct kill of this script alone would leave the timeouts
rem below running, which is exactly the failure RT-001 names.

echo parent=%~nx0
echo ready

rem `timeout` is used instead of `ping -n` because it exists on every supported Windows
rem build and does not require a network stack.
start /b "" cmd /c "echo child-a & timeout /t 30 /nobreak > nul"
start /b "" cmd /c "echo child-b & cmd /c ""echo grandchild-b & timeout /t 30 /nobreak > nul"""

timeout /t 30 /nobreak > nul
