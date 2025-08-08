#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const simpleGit = require('simple-git');
const { Octokit } = require('@octokit/rest');

async function analyzeWithGPT({ testLog, gitDiff }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      RootCauseExplanation:
        'Yerel: OPENAI_API_KEY tanımlı değil. Basit sezgisel analiz: Hata test çıktısındaki son assertion mesajına göre kök neden sınıflandırılmalı.',
      Patch: '',
      TestSuggestions: 'Hata veren fonksiyon için başarısız senaryoya yönelik ek test(ler).',
      RiskAssessment: 'Düşük'
    };
  }

  // Node 18 fetch mevcut. Basit bir istek ile sınırlı süreli çağrı yapalım.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000); // 4 dk limit (XML: <5dk)
  try {
    const prompt = `CI testi başarısız. JSON çıktısı ver. Alanlar: RootCauseExplanation, Patch (unified diff), TestSuggestions, RiskAssessment.\n\n--- TEST LOG ---\n${testLog}\n\n--- GIT DIFF (origin/main) ---\n${gitDiff}`;
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'Sen bir CI hata analiz asistanısın. Yalnızca geçerli JSON döndür.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
      }),
      signal: controller.signal,
    });
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    // İçerik JSON olmalı. Güvenli parse deneyelim.
    try {
      const parsed = JSON.parse(content);
      return parsed;
    } catch (_) {
      // İçerik JSON değilse kaba bir çıkarım yap.
      return {
        RootCauseExplanation: 'Model yanıtı JSON değil, manuel yedek açıklama.',
        Patch: '',
        TestSuggestions: 'Model JSON dönmedi; test önerileri üretilemedi.',
        RiskAssessment: 'Orta',
      };
    }
  } catch (err) {
    return {
      RootCauseExplanation: `Model isteği hata verdi: ${String(err)}`,
      Patch: '',
      TestSuggestions: 'Yerel analiz devreye alınmalı.',
      RiskAssessment: 'Bilinmiyor',
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureGitIdentity(git) {
  try { await git.addConfig('user.name', process.env.GIT_AUTHOR_NAME || 'github-actions[bot]'); } catch {}
  try { await git.addConfig('user.email', process.env.GIT_AUTHOR_EMAIL || 'github-actions[bot]@users.noreply.github.com'); } catch {}
}

function isLikelyUnifiedDiff(text) {
  return /^(diff --git|--- |\+\+\+ )/m.test(text || '');
}

async function run() {
  const git = simpleGit();
  await ensureGitIdentity(git);

  const logFile = path.resolve(process.cwd(), 'latest_test_log.txt');
  let gitDiff = '';
  try {
    gitDiff = execSync('git diff origin/main', { encoding: 'utf8' });
  } catch (e) {
    gitDiff = '';
  }

  let testLog = '';
  if (fs.existsSync(logFile)) {
    testLog = fs.readFileSync(logFile, 'utf8');
  }

  // 1) GPT analizi
  const analysis = await analyzeWithGPT({ testLog, gitDiff });

  // 2) Branch oluşturma
  const shortHash = (await git.revparse(['--short', 'HEAD'])).trim();
  const branchName = `auto-fix/${shortHash}`;
  try {
    await git.checkoutLocalBranch(branchName);
  } catch (_) {
    await git.checkout(branchName).catch(() => {});
  }

  // 3) Çıktıları yaz
  const analysisPath = path.resolve(process.cwd(), 'analysis.json');
  fs.writeFileSync(analysisPath, JSON.stringify({ testLog, gitDiff, analysis }, null, 2), 'utf8');

  let patchPath = null;
  if (analysis?.Patch && typeof analysis.Patch === 'string' && analysis.Patch.trim()) {
    patchPath = path.resolve(process.cwd(), 'suggested_patch.diff');
    fs.writeFileSync(patchPath, analysis.Patch, 'utf8');
  }

  await git.add(['analysis.json'].concat(patchPath ? ['suggested_patch.diff'] : []));
  await git.commit('Auto-fix: CI testi başarısızlığı için analiz ve öneriler');

  // 4) Push
  try {
    await git.push(['--set-upstream', 'origin', branchName]);
  } catch (err) {
    console.warn('Uzak depoya push başarısız:', err?.message || err);
  }

  // 5) PR oluştur
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    console.log('GITHUB_TOKEN bulunamadı; PR oluşturma atlanıyor.');
    console.log('Analiz tamamlandı, analysis.json oluşturuldu.');
    return;
  }
  let remoteUrl = '';
  try { remoteUrl = (await git.remote(['get-url', 'origin'])).trim(); } catch {}
  const match = remoteUrl.match(/[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (!match) {
    console.log('Remote URL çözümlenemedi, PR atlanıyor.');
    return;
  }
  const owner = match[1];
  const repo = match[2];
  const octokit = new Octokit({ auth: token });

  const prTitle = 'AutoFixBot tarafından oluşturulan otomatik düzeltme';
  const prBody = [
    'Bu PR, CI hatası için GPT tarafından önerilen çıktıları içerir.',
    '',
    '## Kök neden',
    analysis?.RootCauseExplanation || 'Belirlenemedi',
    '',
    '## Önerilen Patch',
    isLikelyUnifiedDiff(analysis?.Patch) ? 'Aşağıdaki diff dosyasına bakınız: `suggested_patch.diff`' : 'Üretilemedi veya geçersiz.',
    '',
    '## Test Önerileri',
    analysis?.TestSuggestions || 'Belirtilmedi',
    '',
    '## Risk Değerlendirmesi',
    analysis?.RiskAssessment || 'Belirtilmedi',
  ].join('\n');

  try {
    const { data: pr } = await octokit.pulls.create({
      owner,
      repo,
      title: prTitle,
      head: branchName,
      base: 'main',
      body: prBody,
    });
    console.log(`PR oluşturuldu: ${pr.html_url}`);
  } catch (err) {
    console.warn('PR oluşturma başarısız:', err?.message || err);
  }
}

run().catch((err) => {
  console.error('auto_fix çalışırken hata oluştu:', err);
  process.exit(1);
});


