// github.com:443 不通时,用 gh api 的 Git Data REST 接口推本地提交。
// 用法: node tools/_api-push.cjs <local-commit-sha>
// 前提: 本地 HEAD 的父提交与远程 main 一致(快进推),改动的文件都在工作树。
const { execFileSync } = require('child_process');
const sha = process.argv[2];
if (!sha) { console.log('need commit sha'); process.exit(1); }
function gql(path, input) {
  if (input !== undefined) {
    const out = execFileSync('gh', ['api', path, '-X', 'POST', '--input', '-'], {
      input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 100e6, timeout: 120000,
    });
    return JSON.parse(out);
  }
  const out = execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 100e6, timeout: 120000 });
  return JSON.parse(out);
}
(async () => {
  const repo = 'repos/xiahou001/zcode-wallpaper-xiao';
  const ref = gql(`${repo}/git/ref/heads/main`);
  const baseSha = ref.object.sha;
  console.log('remote main:', baseSha);
  const meta = execFileSync('git', ['show', '-s', '--format=%H%n%P%n%s', sha], { encoding: 'utf8' });
  const [commitSha, parentSha, msg] = meta.split('\n');
  if (parentSha !== baseSha) { console.log('REMOTE DIVERGED: remote', baseSha, 'vs parent', parentSha); process.exit(1); }
  const files = execFileSync('git', ['diff', '--name-status', parentSha, commitSha], { encoding: 'utf8' })
    .trim().split('\n').map((l) => l.split('\t'));
  console.log('changed files:', files.map((f) => f[0] + ' ' + f[1]).join(', '));
  const baseCommit = gql(`${repo}/git/commits/${baseSha}`);
  const baseTree = baseCommit.tree.sha;
  const tree = [];
  for (const [st, p] of files) {
    if (st === 'D') { tree.push({ path: p, mode: '100644', type: 'blob', sha: null }); continue; }
    const content = execFileSync('git', ['show', commitSha + ':' + p], { encoding: 'buffer', maxBuffer: 100e6 });
    const blob = gql(`${repo}/git/blobs`, { content: content.toString('base64'), encoding: 'base64' });
    tree.push({ path: p, mode: '100644', type: 'blob', sha: blob.sha });
    console.log('blob', p, blob.sha.slice(0, 8));
  }
  const newTree = gql(`${repo}/git/trees`, { base_tree: baseTree, tree });
  const newCommit = gql(`${repo}/git/commits`, { message: msg, tree: newTree.sha, parents: [baseSha] });
  console.log('new commit:', newCommit.sha.slice(0, 8));
  gql(`${repo}/git/refs/heads/main`, { sha: newCommit.sha, force: false });
  console.log('PUSHED via API:', newCommit.sha.slice(0, 8), '-', msg.slice(0, 60));
})().catch((e) => { console.log('FAILED:', String(e.message).slice(0, 300)); process.exit(1); });
