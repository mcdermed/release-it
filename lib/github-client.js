import path from 'path';
import GitHubApi from 'github';
import retry from 'async-retry';
import globby from 'globby';
import _ from 'lodash';
import { debugGithubClient, debugGithubApi } from './debug';
import { format } from './util';
import * as log from './log';
import { config } from './config';

const noop = Promise.resolve();

const githubClients = {};

const getGithubClient = ({ host, token }) => {
  if (!githubClients[host]) {
    const client = new GitHubApi({
      version: '3.0.0',
      debug: debugGithubApi.enabled,
      protocol: 'https',
      host: host === 'github.com' ? '' : host,
      pathPrefix: host === 'github.com' ? '' : '/api/v3',
      timeout: 10000,
      headers: {
        'user-agent': 'webpro/release-it'
      }
    });

    client.authenticate({
      type: 'oauth',
      token
    });

    githubClients[host] = client;
  }
  return githubClients[host];
};

const parseErrorMessage = err => {
  const { code, status } = err;
  let msg = err;
  try {
    const errorObj = JSON.parse(err.message);
    const { message, errors } = errorObj;
    const codes = _.map(errors, 'code');
    msg = `${code} ${status}: ${message.replace(/[\n\r]+/g, ' ')} (${codes.join(', ')})`;
  } catch (err) {
    debugGithubClient(err);
  }
  return msg;
};

const NO_RETRIES_NEEDED = [401, 404, 422];

export function release({ version, tagName, repo, changelog = '', github }) {
  log.exec('node-github releases#getReleaseByTag');
  log.exec('node-github releases#createRelease');

  if (config.isDryRun) {
    log.dryRunMessage();
    return noop;
  }

  const tag_name = format(tagName, version);

  return retry(
    async bail =>
      new Promise((resolve, reject) => {
        getReleaseByTag({
          repo,
          github,
          tag_name
        })
          .catch(() => {
            return createRelease({
              repo,
              tag_name,
              github,
              version,
              changelog
            }).catch(bail);
          })
          .then(release => resolve(release));
      }),
    {
      retries: 2
    }
  );
}

function getReleaseByTag({ repo, github, tag_name }) {
  const { host, owner, project } = repo;
  const { token } = github;
  const githubClient = getGithubClient({ host, token });
  return retry(
    async bail =>
      new Promise((resolve, reject) => {
        githubClient.repos.getReleaseByTag(
          {
            owner,
            repo: project,
            tag: tag_name
          },
          (err, response) => {
            if (err) {
              const msg = parseErrorMessage(err);
              const { code } = err;
              // TODO: node-github logs the same in debug mode:
              // debugGithubClient('%O', err);
              if (_.includes(NO_RETRIES_NEEDED, code)) {
                bail(new Error(msg));
                return;
              }
              return reject(err);
            }
            log.verbose(`node-github releases#getReleaseByTag: done (${response.data.id})`);
            debugGithubClient(response);
            resolve(response.data);
          }
        );
      }),
    {
      retries: 2
    }
  );
}

function createRelease({ repo, tag_name, github, version, changelog }) {
  const { preRelease: prerelease, draft, token } = github;
  const { host, owner, project } = repo;
  const githubClient = getGithubClient({ host, token });
  const name = format(github.releaseName, version);

  return retry(
    async bail =>
      new Promise((resolve, reject) => {
        githubClient.repos.createRelease(
          {
            owner,
            repo: project,
            tag_name,
            name,
            body: changelog,
            prerelease,
            draft
          },
          (err, response) => {
            if (err) {
              const msg = parseErrorMessage(err);
              const { code } = err;
              // TODO: node-github logs the same in debug mode:
              // debugGithubClient('%O', err);
              if (_.includes(NO_RETRIES_NEEDED, code)) {
                bail(new Error(msg));
                return;
              }
              return reject(msg);
            } else {
              log.verbose(
                `node-github releases#createRelease: done (${response.meta.location} ${response.data
                  .tag_name} "${response.data.name}")`
              );
              debugGithubClient(response);
              resolve(response.data);
            }
          }
        );
      }),
    {
      retries: 2
    }
  );
}

function uploadAsset({ releaseId, repo, token, filePath }) {
  const name = path.basename(filePath);
  const { host, owner, project } = repo;
  const githubClient = getGithubClient({ host, token });

  return retry(
    async bail =>
      new Promise((resolve, reject) => {
        githubClient.repos.uploadAsset(
          {
            owner,
            repo: project,
            id: releaseId,
            filePath,
            name
          },
          (err, response) => {
            if (err) {
              const msg = parseErrorMessage(err);
              const { code } = err;
              // TODO: node-github logs the same in debug mode:
              // debugGithubClient('%O', err);
              if (_.includes(NO_RETRIES_NEEDED, code)) {
                bail(new Error(msg));
                return;
              }
              return reject(err);
            }
            log.verbose(`node-github releases#uploadAsset: done (${response.data.browser_download_url})`);
            debugGithubClient(response);
            resolve(response.data);
          }
        );
      }),
    {
      retries: 2
    }
  );
}

export function uploadAssets({ releaseId, repo, github }) {
  const { token, assets } = github;

  if (!assets) {
    return noop;
  }

  log.exec('node-github releases#uploadAsset');

  if (config.isDryRun) {
    log.dryRunMessage();
    return noop;
  }

  return globby(assets).then(files => {
    if (!files.length) {
      log.warn(`node-github releases#uploadAssets: assets not found (glob "${assets}" relative to ${process.cwd()})`);
    }
    return Promise.all(files.map(filePath => uploadAsset({ releaseId, repo, filePath, token })));
  });
}
