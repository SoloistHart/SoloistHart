import fs from "node:fs";
import process from "node:process";

import { Octokit } from "@octokit/rest";

const username = process.env.GITHUB_USERNAME?.trim() || "SoloistHart";
const featuredTopic = process.env.FEATURED_TOPIC?.trim() || "featured";
const readmePath = new URL("../README.md", import.meta.url);
const token = process.env.GITHUB_TOKEN?.trim();

if (!token) {
  throw new Error("GITHUB_TOKEN is required to update the profile README.");
}

const octokit = new Octokit({ auth: token });

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
    const description = (repo.description || "No description provided.")
      .replace(/\|/g, "\\|")
      .slice(0, 110);

    return [
      `| [${repo.name}](${repo.html_url})`,
      `${description}`,
      `${repo.language || "N/A"}`,
      `${repo.stargazers_count}`,
      `${formatUpdatedLabel(repo.updated_at)}`,
      "|"
    ].join(" ");
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
  const repositories = await octokit.paginate(octokit.repos.listForUser, {
    username,
    per_page: 100,
    sort: "updated"
  });

  const publicRepositories = repositories.filter((repo) => !repo.private);

  const featuredRepositories = publicRepositories
    .filter((repo) => Array.isArray(repo.topics) && repo.topics.includes(featuredTopic))
    .sort((left, right) => {
      if (right.stargazers_count !== left.stargazers_count) {
        return right.stargazers_count - left.stargazers_count;
      }

      return new Date(right.updated_at) - new Date(left.updated_at);
    });

  if (featuredRepositories.length > 0) {
    return featuredRepositories.slice(0, 8);
  }

  return publicRepositories
    .sort((left, right) => {
      if (right.stargazers_count !== left.stargazers_count) {
        return right.stargazers_count - left.stargazers_count;
      }

      return new Date(right.updated_at) - new Date(left.updated_at);
    })
    .slice(0, 8);
}

async function main() {
  const repositories = await getFeaturedRepositories();
  const table = buildTable(repositories);
  const readme = fs.readFileSync(readmePath, "utf8");
  const nextReadme = replaceFeaturedProjects(readme, table);

  fs.writeFileSync(readmePath, nextReadme);
}

main();