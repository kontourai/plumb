/** Fixture Git commands must never inherit the repository that invoked a hook. */
export function fixtureGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"]) delete env[name];
  return env;
}
