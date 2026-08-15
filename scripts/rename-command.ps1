# One-shot rename of the user-facing command: cbc -> capy
#
# Only a *bare lowercase* `cbc` token is the command name. Three categories that
# contain "cbc" must survive untouched, and they are excluded in different ways.
#
# 1. Internal identifiers — handled by the lookarounds, because an identifier, path,
#    scope, or hyphen character sits next to the token:
#       cbc-runtime  cbc-bench  cbc-protocol      sidecar and crate names
#       @cbc/protocol  apps/cbc/src               package specifiers and paths
#       CBC_MOCK_PROVIDER  CBC_VERSION            environment variables
#       CbcEvent  CbcConfig  CbcPaths             type names
#       CBC (uppercase prose)                     the product referring to itself
#       cbc.test.ts                               filenames
#
# 2. Namespaced data keys — excluded by refusing a trailing colon:
#       cbc:v1:<workspace>:...   the §10.9 prompt cache key format, which the PRD
#                                specifies and provider tests assert
#       cbc:source               an SBOM property key
#
# 3. Strings whose *entire* value is the token — excluded by the evaluator below:
#       clientId: "cbc"          an OAuth client identity
#       "cbc"                    the cache-key prefix element in policy.ts
#
#    A quoted string that merely *starts* with the token is still a command and is
#    replaced, e.g. "cbc auth api" or 'cbc mcp login'. Only the standalone value is
#    protected, which is why this needs an evaluator rather than a lookbehind: a
#    lookbehind on the quote character alone would also skip "cbc auth api".
param([switch]$Apply)

$pattern = '(?<![\w/@.\-])cbc(?![\w/.:\-])'
$root = Split-Path $PSScriptRoot -Parent
$quotes = @('"', "'")

$evaluator = {
    param($m)
    $text = $m.Result('$_')
    $before = if ($m.Index -gt 0) { $text[$m.Index - 1] } else { [char]0 }
    $afterIndex = $m.Index + $m.Length
    $after = if ($afterIndex -lt $text.Length) { $text[$afterIndex] } else { [char]0 }

    if ($quotes -contains [string]$before -and $quotes -contains [string]$after) {
        return $m.Value          # a standalone quoted value: an identity, not a command
    }
    return 'capy'
}

$targets = @()
$targets += Get-ChildItem -Recurse -File -Include *.ts, *.md, *.json -Path `
    "$root\apps", "$root\packages", "$root\benchmarks", "$root\scripts", "$root\docs" |
    Where-Object { $_.FullName -notmatch 'node_modules|\\target\\|\\dist\\' }
$targets += Get-Item "$root\README.md", "$root\package.json"

$totalFiles = 0
$totalHits = 0
$skipped = 0

foreach ($file in $targets | Sort-Object FullName) {
    $text = [IO.File]::ReadAllText($file.FullName)
    if ($text -notmatch $pattern) { continue }

    $changed = 0
    $kept = 0
    $updated = [regex]::Replace($text, $pattern, {
            param($m)
            $b = if ($m.Index -gt 0) { [string]$text[$m.Index - 1] } else { '' }
            $ai = $m.Index + $m.Length
            $a = if ($ai -lt $text.Length) { [string]$text[$ai] } else { '' }
            if ($quotes -contains $b -and $quotes -contains $a) {
                $script:kept += 1
                return $m.Value
            }
            $script:changed += 1
            return 'capy'
        })

    if ($changed -eq 0) {
        if ($kept -gt 0) { "  --  {0}  ({1} protected)" -f $file.FullName.Replace("$root\", ''), $kept }
        $skipped += $kept
        continue
    }

    $totalFiles += 1
    $totalHits += $changed
    $skipped += $kept
    "{0,4}  {1}{2}" -f $changed, $file.FullName.Replace("$root\", ''), $(if ($kept) { "   ($kept protected)" } else { '' })

    if ($Apply) { [IO.File]::WriteAllText($file.FullName, $updated) }
}

""
$verb = if ($Apply) { 'applied' } else { 'dry run' }
"{0}: {1} replacement(s) across {2} file(s); {3} standalone-value occurrence(s) protected" -f `
    $verb, $totalHits, $totalFiles, $skipped
if (-not $Apply) { "pass -Apply to write" }
