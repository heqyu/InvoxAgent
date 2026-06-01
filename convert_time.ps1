$inputFile = "G:\OhMyProjs\InvoxAgent\invox.log"
$outputFile = "G:\OhMyProjs\InvoxAgent\invox_local.log"

# 获取本地时区
$localTimeZone = [System.TimeZoneInfo]::Local

# 读取文件内容
$content = Get-Content $inputFile -Raw

# 正则表达式匹配 ISO 时间格式 (2026-06-01T01:08:11.717Z)
$pattern = '(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})Z'

# 替换函数
$replacement = {
    param($match)
    $isoTime = $match.Groups[1].Value
    # 解析 ISO 时间 (解析为 UTC)
    $dateTime = [DateTime]::Parse($isoTime)
    $dateTime = [DateTime]::SpecifyKind($dateTime, [DateTimeKind]::Utc)
    # 转换到本地时区
    $localTime = [System.TimeZoneInfo]::ConvertTimeFromUtc($dateTime, $localTimeZone)
    # 格式化为月-日-时-分-秒-毫秒
    return $localTime.ToString("MM-dd HH:mm:ss.fff")
}

# 执行替换
$newContent = [regex]::Replace($content, $pattern, $replacement)

# 写入新文件
Set-Content -Path $outputFile -Value $newContent -Encoding UTF8

Write-Host "转换完成！"
Write-Host "原始文件: $inputFile"
Write-Host "转换后文件: $outputFile"
