# Deploy the working tree to the live skill location Claude Code reads.
#
# The repo (this folder) is the source of truth; ~\.claude\skills\claw is the
# installed copy that agents and the `claw` command actually run. Run this
# after making changes. Incremental: robocopy only copies what changed.
#
# Excluded from the mirror (and protected from deletion in the target):
#   .git, .tmp        - repo/dev plumbing
#   runtime state     - the live core's lockfile and logs live in the TARGET

$src = $PSScriptRoot
$dst = Join-Path $env:USERPROFILE '.claude\skills\claw'

# refuse to deploy over a junction/symlink - that would write back into a repo
$existing = Get-Item $dst -ErrorAction SilentlyContinue
if ($existing -and ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    Write-Error "$dst is a junction/symlink - remove it first (cmd /c rmdir), then re-run"
    exit 1
}

robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:1 `
    /XD .git .tmp `
    /XF .claw-daemon.json daemon.log *.log .tldr-browser.json deploy.ps1 | Out-Null

if ($LASTEXITCODE -le 7) {
    Write-Host "deployed $src -> $dst"
    Write-Host "note: if the Claw app is running an older version, quit and relaunch it"
    exit 0
} else {
    Write-Error "robocopy failed with exit code $LASTEXITCODE"
    exit 1
}
