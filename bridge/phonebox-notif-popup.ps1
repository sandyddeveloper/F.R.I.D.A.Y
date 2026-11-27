param([string]$PayloadFile)
$ErrorActionPreference = 'SilentlyContinue'
if (-not $PayloadFile -or -not (Test-Path $PayloadFile)) { exit 0 }

$data = Get-Content $PayloadFile -Raw -Encoding UTF8 | ConvertFrom-Json
try { Remove-Item $PayloadFile -Force } catch {}

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms

$esc = { param($s) [System.Security.SecurityElement]::Escape([string]$s) }
$app = [string]$data.app
$title = [string]$data.title
$text = [string]$data.text
$otp = [string]$data.otp
$canReply = [bool]$data.canReply
$actionIndex = [int]$data.actionIndex
$key = [string]$data.key
$baseUrl = [string]$data.baseUrl
$pin = [string]$data.pin
$token = [string]$data.token

$otpBtn = if ($otp) {
  "<Button x:Name='BtnOtp' Content='Copy OTP $otp' Background='#134e4a' Foreground='#2dd4bf' BorderBrush='#2dd4bf' BorderThickness='1' Padding='10,5' Margin='0,0,6,0' FontWeight='SemiBold' Cursor='Hand'/>"
} else { '' }

$replyRow = if ($canReply) {
  "<DockPanel Margin='0,8,0,0'><Button x:Name='BtnSend' DockPanel.Dock='Right' Content='Send' Background='#2dd4bf' Foreground='#042f2e' BorderThickness='0' Padding='12,5' Margin='6,0,0,0' FontWeight='Bold' Cursor='Hand'/><TextBox x:Name='TxtReply' Background='#090d16' Foreground='#eef2f7' BorderBrush='#334155' BorderThickness='1' Padding='8,5' FontSize='12' CaretBrush='#2dd4bf'/></DockPanel>"
} else { '' }

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False" ShowActivated="False"
        SizeToContent="Height" Width="356" ResizeMode="NoResize">
  <Border CornerRadius="14" Background="#F2101521" BorderBrush="#402DD4BF" BorderThickness="1" Padding="14" Margin="8">
    <Border.Effect>
      <DropShadowEffect Color="Black" BlurRadius="18" ShadowDepth="4" Opacity="0.65"/>
    </Border.Effect>
    <StackPanel>
      <DockPanel Margin="0,0,0,4">
        <Button x:Name="BtnClose" DockPanel.Dock="Right" Content="x" Background="Transparent" Foreground="#94a3b8" BorderThickness="0" FontWeight="Bold" FontSize="13" Padding="6,0" Cursor="Hand"/>
        <TextBlock Text="$(& $esc $app)" Foreground="#2dd4bf" FontSize="11" FontWeight="Bold" VerticalAlignment="Center"/>
      </DockPanel>
      <TextBlock Text="$(& $esc $title)" Foreground="#eef2f7" FontSize="13.5" FontWeight="SemiBold" TextWrapping="Wrap" Margin="0,0,0,2"/>
      <TextBlock x:Name="TxtBody" Text="$(& $esc $text)" Foreground="#cbd5e1" FontSize="12" TextWrapping="Wrap" MaxHeight="76" TextTrimming="CharacterEllipsis"/>
      $replyRow
      <StackPanel Orientation="Horizontal" Margin="0,8,0,0">
        $otpBtn
        <Button x:Name="BtnDismiss" Content="Dismiss Phone" Background="#1e293b" Foreground="#cbd5e1" BorderBrush="#334155" BorderThickness="1" Padding="10,5" Cursor="Hand"/>
      </StackPanel>
    </StackPanel>
  </Border>
</Window>
"@

$win = [Windows.Markup.XamlReader]::Parse($xaml)
$wa = [System.Windows.SystemParameters]::WorkArea
$win.Add_Loaded({
  $win.Left = $wa.Right - $win.ActualWidth - 12
  $win.Top = $wa.Bottom - $win.ActualHeight - 12
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(10)
$timer.Add_Tick({
  if ($win.IsMouseOver -or $win.IsKeyboardFocusWithin) { return }
  $timer.Stop()
  $win.Close()
})
$timer.Start()

function Send-PhonePost([string]$path, [hashtable]$payloadObj) {
  $tmpBody = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($tmpBody, ($payloadObj | ConvertTo-Json -Compress), [System.Text.UTF8Encoding]::new($false))
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'curl.exe'
    $args = @('-sS', '-m', '3', '-X', 'POST', "$baseUrl$path", '-H', 'Content-Type: application/json', '--data-binary', "@$tmpBody")
    if ($pin) { $args += @('-H', "X-PhoneBox-Pin: $pin") }
    if ($token) { $args += @('-H', "X-PhoneBox-Token: $token") }
    $psi.Arguments = ($args | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
    $psi.CreateNoWindow = $true
    $psi.UseShellExecute = $false
    $p = [System.Diagnostics.Process]::Start($psi)
    if ($p) { $p.WaitForExit(3500) | Out-Null }
  } catch {} finally {
    Remove-Item $tmpBody -Force -ErrorAction SilentlyContinue
  }
}

$btnClose = $win.FindName('BtnClose')
if ($btnClose) { $btnClose.Add_Click({ $timer.Stop(); $win.Close() }) }

$btnDismiss = $win.FindName('BtnDismiss')
if ($btnDismiss) {
  $btnDismiss.Add_Click({
    Send-PhonePost '/api/phone-notifications/dismiss' @{ key = $key }
    $timer.Stop(); $win.Close()
  })
}

$btnOtp = $win.FindName('BtnOtp')
if ($btnOtp) {
  $btnOtp.Add_Click({
    try { [System.Windows.Forms.Clipboard]::SetText($otp) } catch {}
    $btnOtp.Content = "Copied $otp"
  })
}

$txtReply = $win.FindName('TxtReply')
$btnSend = $win.FindName('BtnSend')
$sendAction = {
  $msg = if ($txtReply) { $txtReply.Text.Trim() } else { '' }
  if (-not $msg) { return }
  Send-PhonePost '/api/phone-notifications/reply' @{ key = $key; actionIndex = $actionIndex; text = $msg }
  $timer.Stop(); $win.Close()
}
if ($btnSend) { $btnSend.Add_Click($sendAction) }
if ($txtReply) {
  $txtReply.Add_PreviewMouseDown({ $win.Activate() })
  $txtReply.Add_KeyDown({ param($s, $e) if ($e.Key -eq 'Return') { & $sendAction } })
}

$win.ShowDialog() | Out-Null
