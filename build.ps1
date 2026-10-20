# EssayFlow 打包脚本
# 用法：右键点击此文件 → "使用 PowerShell 运行"

$env:HTTP_PROXY = "http://127.0.0.1:10809"
$env:HTTPS_PROXY = "http://127.0.0.1:10809"

Write-Host "正在打包 EssayFlow..." -ForegroundColor Cyan
Write-Host "代理: $env:HTTP_PROXY" -ForegroundColor Gray
Write-Host ""

npm.cmd run build
$buildExitCode = $LASTEXITCODE

Write-Host ""
if ($buildExitCode -eq 0) {
    Write-Host "打包完成！输出目录: dist\" -ForegroundColor Green
} else {
    Write-Host "打包失败，退出码: $buildExitCode" -ForegroundColor Red
}
pause
exit $buildExitCode
