# forger-bench — Devin (SWE-1.6) runner, headless. Generates a submission on the test split.
# Devin's npm shim isn't on the bash PATH, so this runner is PowerShell-native.
# Default model is SWE-1.6 (no --model override).
# usage: powershell -File runners/run_devin.ps1 results/sub_devin.json

param([string]$OutFile = "results/sub_devin.json")

$ErrorActionPreference = "Stop"
$devin = "C:\Users\sarta\AppData\Local\devin\cli\bin\devin.exe"

# Pull the shared prompt + task list from Node so prompts are byte-identical to other runners.
$tasksJson = node -e "const t=require('./tasks');const {buildFlatPrompt}=require('./bench/prompt');console.log(JSON.stringify(t.TEST.map(x=>({id:x.id,prompt:buildFlatPrompt(x)}))))"
$tasks = $tasksJson | ConvertFrom-Json

$solutions = @{}
$ok = 0
$i = 0
foreach ($task in $tasks) {
  $i++
  # Devin reads the prompt as an ARGUMENT after -- (stdin piping panics). -p = print-and-exit.
  $raw = & $devin -p -- $task.prompt 2>&1 | Out-String
  # extract via the shared Node extractor (write raw to temp, extract)
  $tmp = [System.IO.Path]::GetTempFileName()
  Set-Content -Path $tmp -Value $raw -Encoding utf8
  $code = node -e "const fs=require('fs');const {extractCode}=require('./bench/extract');const c=extractCode(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(c||'')" $tmp
  Remove-Item $tmp -Force
  if ($code -and $code.Length -gt 0) { $solutions[$task.id] = $code; $ok++ }
  Write-Host ("  [{0}/{1}] {2} {3}" -f $i, $tasks.Count, $task.id, $(if ($code) {"ok"} else {"NO-CODE"}))
}

# Emit the submission via Node (PowerShell's ConvertTo-Json splits multiline strings into
# arrays and Set-Content -Encoding utf8 adds a BOM — both break the grader). Stage the
# solutions map as a temp JSON of {id: code} and let Node assemble the final submission.
$solTmp = [System.IO.Path]::GetTempFileName()
($solutions | ConvertTo-Json -Depth 10 -Compress) | Set-Content -Path $solTmp -Encoding utf8
node -e "const fs=require('fs');let raw=fs.readFileSync(process.argv[1],'utf8').replace(/^﻿/,'');const sols=JSON.parse(raw);for(const k of Object.keys(sols)){if(Array.isArray(sols[k]))sols[k]=sols[k].join('\n');}const sub={model:'devin-swe-1.6',meta:{runner:'devin',split:'test',extracted:Object.keys(sols).length,total:$($tasks.Count)},solutions:sols};fs.writeFileSync(process.argv[2],JSON.stringify(sub,null,2));" $solTmp $OutFile
Remove-Item $solTmp -Force
Write-Host ("wrote {0} - extracted code for {1}/{2}" -f $OutFile, $ok, $tasks.Count)
