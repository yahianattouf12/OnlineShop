# Requirement 3 practice: prepares a NEW PowerShell window in one command.
# Run it with a dot and a space at the start (so the variables stay in your window), from the OnlineShop folder:
#
#   . .\api-tests\r3\r3-terminal.ps1
#
# It sets: the r3practice Docker project, $cfg, $body, $admin, $customer, $productId.
# The API must already be running (docker compose up -d). It logs in twice (the limit is 5 logins per minute).

Set-Location (Join-Path $PSScriptRoot '..\..')   # the OnlineShop folder
$env:COMPOSE_PROJECT_NAME = 'r3practice'

$cfg  = Get-Content .env | ConvertFrom-StringData
$body = @{ email = 'customer@test.local'; password = 'Customer-Pass-123!' } | ConvertTo-Json
$api  = 'http://localhost:8080/api/v1'

try {
    $adminBody = @{ email = $cfg.ADMIN_EMAIL; password = $cfg.ADMIN_PASSWORD } | ConvertTo-Json
    $adminLogin = Invoke-RestMethod -Method Post "$api/auth/login" -ContentType 'application/json' -Body $adminBody
    $admin = $adminLogin.accessToken
    $customer = (Invoke-RestMethod -Method Post "$api/auth/login" -ContentType 'application/json' -Body $body).accessToken
    $productId = (Invoke-RestMethod "$api/products?page=1&pageSize=1").items[0].id

    Write-Host "Folder:     $(Get-Location)"
    Write-Host "Project:    $env:COMPOSE_PROJECT_NAME"
    Write-Host "Tokens:     admin + customer, valid until $($adminLogin.expiresAtUtc) (UTC)"
    Write-Host "Product id: $productId"
}
catch {
    Write-Host "Login failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Is the API running? Try: docker compose ps   (names must start with r3practice-)"
    Write-Host "Did you register the test customer (step D0)? Or wait a minute (5 logins per minute)."
}

# Sends ONE GET request and prints how many SQL queries the app ran for it (from the app log).
# It reads the log from the exact moment before the request, so it works even when commands run back to back.
#   Measure-SqlQueries "/products?page=1&pageSize=12"
#   Measure-SqlQueries "/orders?page=1&pageSize=50" $admin
function Measure-SqlQueries([string]$Path, [string]$Token) {
    $headers = @{}
    if ($Token) { $headers.Authorization = "Bearer $Token" }
    $since = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    Invoke-RestMethod "$api$Path" -Headers $headers | Out-Null
    Start-Sleep -Milliseconds 500   # give the log a moment to be written
    $count = (docker compose logs app --since $since | Select-String 'Executed DbCommand').Count
    Write-Host "GET $Path -> $count SQL queries"
}
