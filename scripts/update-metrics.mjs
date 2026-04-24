import fs from "node:fs";
import process from "node:process";

const outputPath = new URL("../github-metrics.svg", import.meta.url);
const username = process.env.GITHUB_USERNAME?.trim();
const token = process.env.GITHUB_TOKEN?.trim() || process.env.METRICS_TOKEN?.trim();

if (!token) {
  throw new Error("GITHUB_TOKEN or METRICS_TOKEN is required to generate metrics.");
}

const query = `
  query ViewerMetrics($after: String, $from: DateTime!, $to: DateTime!) {
    viewer {
      login
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
        }
        totalCommitContributions
        totalIssueContributions
        totalPullRequestContributions
        restrictedContributionsCount
        totalRepositoriesWithContributedCommits
      }
      repositories(
        first: 100
        after: $after
        ownerAffiliations: OWNER
        orderBy: { field: PUSHED_AT, direction: DESC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          name
          isPrivate
          stargazerCount
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges {
              size
              node {
                name
                color
              }
            }
          }
        }
      }
    }
  }
`;

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function requestGitHubGraphQL(variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "soloisthart-profile-metrics"
    },
    body: JSON.stringify({ query, variables })
  });

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed with ${response.status} ${response.statusText}.`);
  }

  const payload = await response.json();

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  return payload.data;
}

async function getMetrics() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 365);

  let after = null;
  let repositories = [];
  let contributionData = null;
  let login = username;

  while (true) {
    const data = await requestGitHubGraphQL({
      after,
      from: from.toISOString(),
      to: to.toISOString()
    });

    const viewer = data.viewer;
    login = username || viewer.login;
    contributionData ||= viewer.contributionsCollection;
    repositories = repositories.concat(viewer.repositories.nodes);

    if (!viewer.repositories.pageInfo.hasNextPage) {
      break;
    }

    after = viewer.repositories.pageInfo.endCursor;
  }

  const languageTotals = new Map();
  let totalStars = 0;
  let privateRepos = 0;

  for (const repository of repositories) {
    totalStars += repository.stargazerCount;

    if (repository.isPrivate) {
      privateRepos += 1;
    }

    for (const edge of repository.languages.edges) {
      const existing = languageTotals.get(edge.node.name) || { size: 0, color: edge.node.color || "#D8B77A" };
      existing.size += edge.size;
      existing.color = edge.node.color || existing.color || "#D8B77A";
      languageTotals.set(edge.node.name, existing);
    }
  }

  const sortedLanguages = [...languageTotals.entries()]
    .map(([name, details]) => ({ name, ...details }))
    .sort((left, right) => right.size - left.size)
    .slice(0, 6);

  const totalLanguageSize = sortedLanguages.reduce((sum, language) => sum + language.size, 0) || 1;
  const languages = sortedLanguages.map((language) => ({
    ...language,
    percentage: (language.size / totalLanguageSize) * 100
  }));

  return {
    login,
    totalRepos: repositories.length,
    privateRepos,
    publicRepos: repositories.length - privateRepos,
    totalStars,
    contributions: contributionData
      ? {
          total: contributionData.contributionCalendar.totalContributions,
          commits: contributionData.totalCommitContributions,
          pullRequests: contributionData.totalPullRequestContributions,
          issues: contributionData.totalIssueContributions,
          privateCount: contributionData.restrictedContributionsCount,
          repositoriesContributed: contributionData.totalRepositoriesWithContributedCommits
        }
      : {
          total: 0,
          commits: 0,
          pullRequests: 0,
          issues: 0,
          privateCount: 0,
          repositoriesContributed: 0
        },
    languages
  };
}

function buildLanguageLegend(languages) {
  return languages
    .map((language, index) => {
      const x = index % 2 === 0 ? 572 : 742;
      const y = 302 + Math.floor(index / 2) * 30;
      const label = `${language.name} ${language.percentage.toFixed(1)}%`;

      return [
        `<circle cx="${x}" cy="${y}" r="6" fill="${language.color || "#D8B77A"}" />`,
        `<text x="${x + 16}" y="${y + 5}" fill="#D7C8B1" font-family="Segoe UI, Arial, sans-serif" font-size="13">${escapeXml(label)}</text>`
      ].join("\n");
    })
    .join("\n");
}

function buildLanguageBar(languages) {
  const totalWidth = 320;
  let offset = 0;

  return languages
    .map((language) => {
      const width = Math.max(12, Math.round((language.percentage / 100) * totalWidth));
      const rect = `<rect x="${560 + offset}" y="252" width="${width}" height="12" rx="6" fill="${language.color || "#D8B77A"}" />`;
      offset += width;
      return rect;
    })
    .join("\n");
}

function renderMetricsSvg(metrics) {
  const cards = [
    { label: "Contributions", value: formatNumber(metrics.contributions.total), subtext: "Last 12 months" },
    { label: "Owned repos", value: formatNumber(metrics.totalRepos), subtext: `${formatNumber(metrics.privateRepos)} private` },
    { label: "Stars earned", value: formatNumber(metrics.totalStars), subtext: "Across owned repos" },
    { label: "Code touchpoints", value: formatNumber(metrics.contributions.repositoriesContributed), subtext: "Repos with contributed commits" }
  ];

  const cardMarkup = cards
    .map((card, index) => {
      const x = 64 + index * 118;
      return `
        <rect x="${x}" y="132" width="102" height="92" rx="16" fill="rgba(255,255,255,0.03)" stroke="rgba(216,183,122,0.18)" />
        <text x="${x + 16}" y="158" fill="#8E98A5" font-family="Segoe UI, Arial, sans-serif" font-size="11" letter-spacing="1.5">${escapeXml(card.label.toUpperCase())}</text>
        <text x="${x + 16}" y="191" fill="#F2ECE4" font-family="Segoe UI, Arial, sans-serif" font-size="28" font-weight="700">${escapeXml(card.value)}</text>
        <text x="${x + 16}" y="211" fill="#A8B1BE" font-family="Segoe UI, Arial, sans-serif" font-size="12">${escapeXml(card.subtext)}</text>
      `;
    })
    .join("\n");

  const breakdown = [
    { label: "Commits", value: metrics.contributions.commits },
    { label: "Pull requests", value: metrics.contributions.pullRequests },
    { label: "Issues", value: metrics.contributions.issues },
    { label: "Private contributions", value: metrics.contributions.privateCount }
  ];

  const breakdownMarkup = breakdown
    .map((item, index) => {
      const y = 286 + index * 34;
      return `
        <text x="80" y="${y}" fill="#D7C8B1" font-family="Segoe UI, Arial, sans-serif" font-size="14">${escapeXml(item.label)}</text>
        <text x="344" y="${y}" fill="#F2ECE4" font-family="Segoe UI, Arial, sans-serif" font-size="14" font-weight="600" text-anchor="end">${escapeXml(formatNumber(item.value))}</text>
      `;
    })
    .join("\n");

  return `<svg width="960" height="420" viewBox="0 0 960 420" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">GitHub metrics for ${escapeXml(metrics.login)}</title>
  <desc id="desc">Private-aware GitHub metrics generated for ${escapeXml(metrics.login)}, including contribution totals, repository counts, and top languages.</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="960" y2="420" gradientUnits="userSpaceOnUse">
      <stop stop-color="#0B1016" />
      <stop offset="0.58" stop-color="#101722" />
      <stop offset="1" stop-color="#151C28" />
    </linearGradient>
    <linearGradient id="accent" x1="72" y1="74" x2="328" y2="132" gradientUnits="userSpaceOnUse">
      <stop stop-color="#F1D4A3" />
      <stop offset="0.48" stop-color="#D8B77A" />
      <stop offset="1" stop-color="#B78B44" />
    </linearGradient>
    <pattern id="grid" width="34" height="34" patternUnits="userSpaceOnUse">
      <path d="M34 0H0V34" stroke="rgba(216,183,122,0.06)" stroke-width="1" />
    </pattern>
  </defs>
  <rect width="960" height="420" rx="24" fill="url(#bg)" />
  <rect width="960" height="420" rx="24" fill="url(#grid)" opacity="0.8" />
  <rect x="14" y="14" width="932" height="392" rx="18" stroke="rgba(255,255,255,0.08)" />
  <rect x="34" y="34" width="892" height="352" rx="18" stroke="rgba(216,183,122,0.14)" />
  <text x="64" y="84" fill="#8E98A5" font-family="Segoe UI, Arial, sans-serif" font-size="11" letter-spacing="3">GITHUB METRICS</text>
  <text x="64" y="126" fill="url(#accent)" font-family="Segoe UI, Arial, sans-serif" font-size="34" font-weight="700">Private-aware account snapshot</text>
  <text x="64" y="156" fill="#A8B1BE" font-family="Segoe UI, Arial, sans-serif" font-size="14">Generated from your authenticated GitHub data, including private contribution visibility when the token allows it.</text>
  ${cardMarkup}
  <rect x="64" y="248" width="308" height="150" rx="18" fill="rgba(255,255,255,0.03)" stroke="rgba(216,183,122,0.18)" />
  <text x="80" y="274" fill="#8E98A5" font-family="Segoe UI, Arial, sans-serif" font-size="11" letter-spacing="2">CONTRIBUTION BREAKDOWN</text>
  ${breakdownMarkup}
  <rect x="392" y="248" width="472" height="150" rx="18" fill="rgba(255,255,255,0.03)" stroke="rgba(216,183,122,0.18)" />
  <text x="560" y="234" fill="#8E98A5" font-family="Segoe UI, Arial, sans-serif" font-size="11" letter-spacing="2">TOP LANGUAGES</text>
  ${buildLanguageBar(metrics.languages)}
  ${buildLanguageLegend(metrics.languages)}
</svg>`;
}

async function main() {
  const metrics = await getMetrics();
  const svg = renderMetricsSvg(metrics);
  fs.writeFileSync(outputPath, svg);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
