@echo off
setlocal
npm config set registry https://registry.npmjs.org/
if exist node_modules rmdir /s /q node_modules
npm cache verify
npm ci
if errorlevel 1 exit /b %errorlevel%
npm run compile
if errorlevel 1 exit /b %errorlevel%
echo.
echo Dependencies and TypeScript compilation are ready.
echo Run: vsce login jc-tools
echo Then: vsce publish --allow-missing-repository
endlocal
