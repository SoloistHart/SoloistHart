import fs from "node:fs";
import process from "node:process";

const username = process.env.GITHUB_USERNAME?.trim() || "SoloistHart";
const featuredTopic = process.env.FEATURED_TOPIC?.trim() || "featured";
const readmePath = new URL("../README.md", import.meta.url);
const token = process.env.GITHUB_TOKEN?.trim();
const descriptionOverrides = {
  "Portfolio-Hart": "Premium portfolio foundation built with Next.js, TypeScript, and a motion-aware visual system.",
  SoloistHart: "Automated GitHub profile README with generated featured projects and custom profile assets."
};

function getRepositoryDescription(repo) {
  return descriptionOverrides[repo.name] || repo.description || "No description provided.";
}

function compareRepositories(left, right) {
  const leftHasDescription = Number(Boolean(descriptionOverrides[left.name] || left.description));
  const rightHasDescription = Number(Boolean(descriptionOverrides[right.name] || right.description));

  if (rightHasDescription !== leftHasDescription) {
    return rightHasDescription - leftHasDescription;
  }

  if (Number(!right.fork) !== Number(!left.fork)) {
    return Number(!right.fork) - Number(!left.fork);
  }

  if (right.stargazers_count !== left.stargazers_count) {
    return right.stargazers_count - left.stargazers_count;
  }

  return new Date(right.updated_at) - new Date(left.updated_at);
}

async function requestGitHub(pathname, searchParams = {}) {
  const url = new URL(`https://api.github.com${pathname}`);

  Object.entries(searchParams).forEach(([key, value]) => {
    url.searchParams.set(key, String(value));
  });

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "soloisthart-profile-readme-updater"
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(`GitHub API request failed with ${response.status} ${response.statusText}.`);
  }

  return response.json();
}

function formatUpdatedLabel(dateString) {
  const updated = new Date(dateString);
  const now = new Date();
  const diffDays = Math.max(0, Math.floor((now - updated) / (1000 * 60 * 60 * 24)));

  if (diffDays === 0) {
    return `<span title="${updated.toISOString().slice(0, 10)}">Today</span>`;
  }

  if (diffDays === 1) {
    return `<span title="${updated.toISOString().slice(0, 10)}">1 day ago</span>`;
  }

  return `<span title="${updated.toISOString().slice(0, 10)}">${diffDays} days ago</span>`;
}

function buildTable(repositories) {
  const header = [
    "| Repository | Description | Primary Language | Stars | Last Updated |",
    "| ---------- | ----------- | ---------------- | ----- | ------------ |"
  ];

  const rows = repositories.map((repo) => {
    const description = getRepositoryDescription(repo)
      .replace(/\|/g, "\\|")
      .slice(0, 110);

    return `| [${repo.name}](${repo.html_url}) | ${description} | ${repo.language || "N/A"} | ${repo.stargazers_count} | ${formatUpdatedLabel(repo.updated_at)} |`;
  });

  return [...header, ...rows].join("\n");
}

function replaceFeaturedProjects(readme, table) {
  const startMarker = "<!-- featured-projects:start -->";
  const endMarker = "<!-- featured-projects:end -->";
  const start = readme.indexOf(startMarker);
  const end = readme.indexOf(endMarker);

  if (start === -1 || end === -1 || end < start) {
    throw new Error("Featured project markers are missing from README.md.");
  }

  return `${readme.slice(0, start + startMarker.length)}\n${table}\n${readme.slice(end)}`;
}

async function getFeaturedRepositories() {
  const repositories = await requestGitHub(`/users/${username}/repos`, {
    per_page: 100,
    sort: "updated"
  });

  const publicRepositories = repositories.filter((repo) => !repo.private);
  const candidateRepositories = publicRepositories.filter((repo) => repo.name !== username);
  const repositoriesForSelection = candidateRepositories.length > 0
    ? candidateRepositories
    : publicRepositories;

  const featuredRepositories = repositoriesForSelection
    .filter((repo) => Array.isArray(repo.topics) && repo.topics.includes(featuredTopic))
    .sort(compareRepositories);

  if (featuredRepositories.length > 0) {
    return featuredRepositories.slice(0, 6);
  }

  return repositoriesForSelection
    .sort(compareRepositories)
    .slice(0, 6);
}

async function main() {
  const repositories = await getFeaturedRepositories();
  const table = buildTable(repositories);
  const readme = fs.readFileSync(readmePath, "utf8");
  const nextReadme = replaceFeaturedProjects(readme, table);

  fs.writeFileSync(readmePath, nextReadme);
}

main();