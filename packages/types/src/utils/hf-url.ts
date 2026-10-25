export function hfModelUrl(repo: string, path: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${path}`
}
