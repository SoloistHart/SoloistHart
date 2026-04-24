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
          weeks {
            contributionDays {
              contributionCount
              date
            }
          }
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
          isPrivate
          stargazerCount
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

function formatShortDate(value) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

function formatCompactDate(value) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric"
  });
}

function getDaysBetween(start, end) {
  return Math.round((end - start) / (1000 * 60 * 60 * 24));
}

function computeStreaks(days) {
  const normalizedDays = days
    .map((day) => ({ ...day, dateObject: new Date(day.date) }))
    .sort((left, right) => left.dateObject - right.dateObject);

  let currentStreak = { count: 0, start: null, end: null };

  for (let index = normalizedDays.length - 1; index >= 0; index -= 1) {
    const day = normalizedDays[index];

    if (day.contributionCount <= 0) {
      if (index === normalizedDays.length - 1) {
        currentStreak = { count: 0, start: null, end: null };
      }
      break;
    }

    if (currentStreak.count === 0) {
      currentStreak = { count: 1, start: day.date, end: day.date };
      continue;
    }

    const previous = normalizedDays[index + 1];
    const dayDiff = getDaysBetween(day.dateObject, previous.dateObject);

    if (dayDiff === 1) {
      currentStreak.count += 1;
      currentStreak.start = day.date;
    } else {
      break;
    }
  }

  let longestStreak = { count: 0, start: null, end: null };
  let activeStreak = { count: 0, start: null, end: null };

  for (const day of normalizedDays) {
    if (day.contributionCount > 0) {
      if (activeStreak.count === 0) {
        activeStreak = { count: 1, start: day.date, end: day.date };
      } else {
        const previousDate = new Date(activeStreak.end);
        const currentDate = new Date(day.date);
        const dayDiff = getDaysBetween(previousDate, currentDate);

        if (dayDiff === 1) {
          activeStreak.count += 1;
          activeStreak.end = day.date;
        } else {
          if (activeStreak.count > longestStreak.count) {
            longestStreak = { ...activeStreak };
          }
          activeStreak = { count: 1, start: day.date, end: day.date };
        }
      }
    } else if (activeStreak.count > 0) {
      if (activeStreak.count > longestStreak.count) {
        longestStreak = { ...activeStreak };
      }
      activeStreak = { count: 0, start: null, end: null };
    }
  }

  if (activeStreak.count > longestStreak.count) {
    longestStreak = { ...activeStreak };
  }

  return { currentStreak, longestStreak };
}

function describeStreak(streak, isCurrent = false) {
  if (!streak.count || !streak.start || !streak.end) {
    return isCurrent ? "No active streak" : "No streak recorded";
  }

  if (isCurrent) {
    return `${formatCompactDate(streak.start)} - Present`;
  }

  return `${formatCompactDate(streak.start)} - ${formatCompactDate(streak.end)}`;
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

  const totalStars = repositories.reduce((sum, repository) => sum + repository.stargazerCount, 0);
  const privateRepos = repositories.filter((repository) => repository.isPrivate).length;
  const contributionDays = contributionData?.contributionCalendar.weeks.flatMap((week) => week.contributionDays) || [];
  const { currentStreak, longestStreak } = computeStreaks(contributionDays);

  return {
    login,
    totalStars,
    totalRepos: repositories.length,
    privateRepos,
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
    currentStreak,
    longestStreak
  };
}

function renderStatsRows(metrics) {
  const rows = [
    { label: "Total Stars Earned", value: metrics.totalStars, icon: "star" },
    { label: "Total Commits (last year)", value: metrics.contributions.commits, icon: "commit" },
    { label: "Total PRs", value: metrics.contributions.pullRequests, icon: "pr" },
    { label: "Total Issues", value: metrics.contributions.issues, icon: "issue" },
    { label: "Private Contributions", value: metrics.contributions.privateCount, icon: "lock" }
  ];

  const icons = {
    star: '<path d="M0 -8L2.3 -2.5L8 0L2.3 2.5L0 8L-2.3 2.5L-8 0L-2.3 -2.5Z" fill="none" stroke="#D8B77A" stroke-width="1.6" stroke-linejoin="round" />',
    commit: '<circle cx="0" cy="0" r="7" fill="none" stroke="#D8B77A" stroke-width="1.6" /><path d="M0 -3V0L3 2" stroke="#D8B77A" stroke-width="1.6" stroke-linecap="round" />',
    pr: '<circle cx="-6" cy="-6" r="3" fill="none" stroke="#D8B77A" stroke-width="1.6" /><circle cx="6" cy="0" r="3" fill="none" stroke="#D8B77A" stroke-width="1.6" /><circle cx="-6" cy="6" r="3" fill="none" stroke="#D8B77A" stroke-width="1.6" /><path d="M-3.4 -4.2H1.8M-6 -3V3" stroke="#D8B77A" stroke-width="1.6" stroke-linecap="round" />',
    issue: '<circle cx="0" cy="0" r="7" fill="none" stroke="#D8B77A" stroke-width="1.6" /><path d="M0 -3V1" stroke="#D8B77A" stroke-width="1.6" stroke-linecap="round" /><circle cx="0" cy="4" r="1" fill="#D8B77A" />',
    lock: '<rect x="-5.5" y="-1" width="11" height="9" rx="2" fill="none" stroke="#D8B77A" stroke-width="1.6" /><path d="M-3.2 -1V-3.2C-3.2 -5  -1.8 -6.5 0 -6.5C1.8 -6.5 3.2 -5 3.2 -3.2V-1" stroke="#D8B77A" stroke-width="1.6" stroke-linecap="round" />'
  };

  return rows
    .map((row, index) => {
      const y = 138 + index * 30;
      return `
        <g transform="translate(64 ${y - 5})">${icons[row.icon]}</g>
        <text x="84" y="${y}" fill="#D7C8B1" font-family="Segoe UI, Arial, sans-serif" font-size="12.5" font-weight="600">${escapeXml(row.label)}:</text>
        <text x="296" y="${y}" fill="#F2ECE4" font-family="Segoe UI, Arial, sans-serif" font-size="13" font-weight="700">${escapeXml(formatNumber(row.value))}</text>
      `;
    })
    .join("\n");
}

function renderMetricsSvg(metrics) {
  return `<svg width="960" height="320" viewBox="0 0 960 320" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title desc">
  <title id="title">GitHub metrics for ${escapeXml(metrics.login)}</title>
  <desc id="desc">Private-aware GitHub metrics generated for ${escapeXml(metrics.login)}, including contribution totals and streaks.</desc>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="960" y2="320" gradientUnits="userSpaceOnUse">
      <stop stop-color="#0B1016" />
      <stop offset="0.58" stop-color="#101722" />
      <stop offset="1" stop-color="#151C28" />
    </linearGradient>
    <linearGradient id="accent" x1="56" y1="44" x2="290" y2="98" gradientUnits="userSpaceOnUse">
      <stop stop-color="#F1D4A3" />
      <stop offset="0.48" stop-color="#D8B77A" />
      <stop offset="1" stop-color="#B78B44" />
    </linearGradient>
    <pattern id="grid" width="34" height="34" patternUnits="userSpaceOnUse">
      <path d="M34 0H0V34" stroke="rgba(216,183,122,0.06)" stroke-width="1" />
    </pattern>
  </defs>
  <rect width="960" height="320" rx="24" fill="url(#bg)" />
  <rect width="960" height="320" rx="24" fill="url(#grid)" opacity="0.72" />
  <rect x="14" y="14" width="932" height="292" rx="18" stroke="rgba(255,255,255,0.08)" />
  <rect x="30" y="30" width="436" height="260" rx="20" fill="rgba(255,255,255,0.03)" stroke="rgba(216,183,122,0.18)" />
  <rect x="494" y="30" width="436" height="260" rx="20" fill="rgba(255,255,255,0.03)" stroke="rgba(216,183,122,0.18)" />

  <text x="56" y="84" fill="url(#accent)" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="700">${escapeXml(metrics.login)}&apos;s GitHub Stats</text>
  ${renderStatsRows(metrics)}
  <circle cx="390" cy="166" r="44" fill="none" stroke="rgba(216,183,122,0.22)" stroke-width="8" />
  <circle cx="390" cy="166" r="44" fill="rgba(216,183,122,0.08)" />
  <text x="390" y="175" fill="#F2ECE4" font-family="Segoe UI, Arial, sans-serif" font-size="28" font-weight="700" text-anchor="middle">${escapeXml(formatNumber(metrics.contributions.total))}</text>
  <text x="390" y="226" fill="#A8B1BE" font-family="Segoe UI, Arial, sans-serif" font-size="10.5" text-anchor="middle">Last 12 months</text>

  <text x="520" y="76" fill="#8E98A5" font-family="Segoe UI, Arial, sans-serif" font-size="9.5" letter-spacing="2">CONTRIBUTION SNAPSHOT</text>

  <text x="575" y="132" fill="#F1D4A3" font-family="Segoe UI, Arial, sans-serif" font-size="36" font-weight="700" text-anchor="middle">${escapeXml(formatNumber(metrics.contributions.total))}</text>
  <text x="575" y="162" fill="#D7C8B1" font-family="Segoe UI, Arial, sans-serif" font-size="14" text-anchor="middle">Total Contributions</text>
  <text x="575" y="188" fill="#BCA381" font-family="Segoe UI, Arial, sans-serif" font-size="11" text-anchor="middle">Last 12 months</text>

  <path d="M649 98V226" stroke="rgba(255,255,255,0.2)" stroke-width="1" />

  <circle cx="720" cy="150" r="32" fill="none" stroke="#D8B77A" stroke-width="6" />
  <text x="720" y="158" fill="#F1D4A3" font-family="Segoe UI, Arial, sans-serif" font-size="18" font-weight="700" text-anchor="middle">${escapeXml(formatNumber(metrics.currentStreak.count))}</text>
  <text x="720" y="200" fill="#D7C8B1" font-family="Segoe UI, Arial, sans-serif" font-size="13" font-weight="600" text-anchor="middle">Current Streak</text>
  <text x="720" y="222" fill="#BCA381" font-family="Segoe UI, Arial, sans-serif" font-size="10" text-anchor="middle">${escapeXml(describeStreak(metrics.currentStreak, true))}</text>

  <path d="M775 98V226" stroke="rgba(255,255,255,0.2)" stroke-width="1" />

  <text x="838" y="132" fill="#F1D4A3" font-family="Segoe UI, Arial, sans-serif" font-size="36" font-weight="700" text-anchor="middle">${escapeXml(formatNumber(metrics.longestStreak.count))}</text>
  <text x="838" y="162" fill="#D7C8B1" font-family="Segoe UI, Arial, sans-serif" font-size="14" text-anchor="middle">Longest Streak</text>
  <text x="838" y="188" fill="#BCA381" font-family="Segoe UI, Arial, sans-serif" font-size="10" text-anchor="middle">${escapeXml(describeStreak(metrics.longestStreak))}</text>
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
