import * as Config from '@oclif/config'
import {CLIError} from '@oclif/errors'
import cli from 'cli-ux'
import * as fs from 'fs'
import * as fse from 'fs-extra'
import HTTP from 'http-call'
import loadJSON from 'load-json-file'
import * as path from 'path'
import * as semver from 'semver'

import {uniq, uniqWith} from './util'
import Yarn from './yarn'

const initPJSON: Config.PJSON.User = {private: true, oclif: {schema: 1, plugins: []}, dependencies: {}}

export default class Plugins {
  verbose = false
  readonly yarn: Yarn
  private readonly debug: any

  constructor(public config: Config.IConfig) {
    this.yarn = new Yarn({config})
    this.debug = require('debug')('@oclif/plugins')
  }

  async pjson(): Promise<Config.PJSON.User> {
    try {
      const pjson = await loadJSON<Config.PJSON>(this.pjsonPath)
      return {
        ...initPJSON,
        oclif: {
          ...initPJSON.oclif,
          ...pjson.oclif,
        },
        dependencies: {},
        ...pjson,
      }
    } catch (err) {
      this.debug(err)
      if (err.code !== 'ENOENT') process.emitWarning(err)
      return initPJSON
    }
  }

  async list() {
    const pjson = await this.pjson()
    return this.normalizePlugins(pjson.oclif.plugins)
  }

  async install(name: string, {tag = 'latest', force = false} = {}): Promise<Config.IConfig> {
    try {
      const yarnOpts = {cwd: this.config.dataDir, verbose: this.verbose}
      await this.createPJSON()
      let plugin
      const add = force ? ['add', '--force'] : ['add']
      if (name.includes(':')) {
        // url
        const url = name
        await this.yarn.exec([...add, url], yarnOpts)
        name = Object.entries((await this.pjson()).dependencies || {}).find(([, u]: any) => u === url)![0]
        plugin = await Config.load({devPlugins: false, userPlugins: false, root: path.join(this.config.dataDir, 'node_modules', name), name})
        await this.refresh(plugin.root)
        if (!plugin.valid && !this.config.plugins.find(p => p.name === '@oclif/plugin-legacy')) {
          throw new Error('plugin is invalid')
        }
        await this.add({name, url, type: 'user'})
      } else {
        // npm
        const range = semver.validRange(tag)
        const unfriendly = this.unfriendlyName(name)
        if (unfriendly && await this.npmHasPackage(unfriendly)) {
          name = unfriendly
        }
        await this.yarn.exec([...add, `${name}@${tag}`], yarnOpts)
        plugin = await Config.load({devPlugins: false, userPlugins: false, root: path.join(this.config.dataDir, 'node_modules', name), name})
        if (!plugin.valid && !this.config.plugins.find(p => p.name === '@oclif/plugin-legacy')) {
          throw new Error('plugin is invalid')
        }
        await this.refresh(plugin.root)
        await this.add({name, tag: range || tag, type: 'user'})
      }
      return plugin
    } catch (err) {
      await this.uninstall(name).catch(err => this.debug(err))
      throw err
    }
  }

  // if yarn.lock exists, fetch locked dependencies
  async refresh(root: string, {prod = true}: {prod?: boolean} = {}) {
    if (fs.existsSync(path.join(root, 'yarn.lock'))) {
      // use yarn.lock to fetch dependencies
      await this.yarn.exec(prod ? ['--prod'] : [], {cwd: root, verbose: this.verbose})
    }
  }

  async link(p: string) {
    const c = await Config.load(path.resolve(p))
    cli.action.start(`${this.config.name}: linking plugin ${c.name}`)
    if (!c.valid && !this.config.plugins.find(p => p.name === '@oclif/plugin-legacy')) {
      throw new CLIError('plugin is not a valid oclif plugin')
    }
    await this.refresh(c.root, {prod: false})
    await this.add({type: 'link', name: c.name, root: c.root})
  }

  async add(plugin: Config.PJSON.PluginTypes) {
    const pjson = await this.pjson()
    pjson.oclif.plugins = uniq([...pjson.oclif.plugins || [], plugin]) as any
    await this.savePJSON(pjson)
  }

  async remove(name: string) {
    const pjson = await this.pjson()
    if (pjson.dependencies) delete pjson.dependencies[name]
    pjson.oclif.plugins = this.normalizePlugins(pjson.oclif.plugins)
    .filter(p => p.name !== name)
    await this.savePJSON(pjson)
  }

  async uninstall(name: string) {
    try {
      const pjson = await this.pjson()
      if ((pjson.oclif.plugins || []).find(p => typeof p === 'object' && p.type === 'user' && p.name === name)) {
        await this.yarn.exec(['remove', name], {cwd: this.config.dataDir, verbose: this.verbose})
      }
    } catch (err) {
      cli.warn(err)
    } finally {
      await this.remove(name)
    }
  }

  async update() {
    let plugins = (await this.list()).filter((p): p is Config.PJSON.PluginTypes.User => p.type === 'user')
    if (plugins.length === 0) return
    cli.action.start(`${this.config.name}: Updating plugins`)

    // migrate deprecated plugins
    const aliases = this.config.pjson.oclif.aliases || {}
    for (let [name, to] of Object.entries(aliases)) {
      const plugin = plugins.find(p => p.name === name)
      if (!plugin) continue
      if (to) await this.install(to)
      await this.uninstall(name)
      plugins = plugins.filter(p => p.name !== name)
    }

    if (plugins.find(p => !!p.url)) {
      await this.yarn.exec(['upgrade'], {cwd: this.config.dataDir, verbose: this.verbose})
    }
    const npmPlugins = plugins.filter(p => !p.url)
    if (npmPlugins.length) {
      await this.yarn.exec(['add', ...npmPlugins.map(p => `${p.name}@${p.tag}`)], {cwd: this.config.dataDir, verbose: this.verbose})
    }
    for (let p of plugins) {
      await this.refresh(path.join(this.config.dataDir, 'node_modules', p.name))
    }
    cli.action.stop()
  }

  async hasPlugin(name: string) {
    const list = await this.list()
    return list.find(p => {
      if (this.friendlyName(p.name) === this.friendlyName(name)) return true
      if (p.type === 'link') {
        if (path.resolve(p.root) === path.resolve(name)) return true
      }
      return false
    })
  }

  async yarnNodeVersion(): Promise<string | undefined> {
    try {
      let f = await loadJSON<{nodeVersion: string}>(path.join(this.config.dataDir, 'node_modules', '.yarn-integrity'))
      return f.nodeVersion
    } catch (err) {
      if (err.code !== 'ENOENT') cli.warn(err)
    }
  }

  unfriendlyName(name: string): string | undefined {
    if (name.includes('@')) return
    const scope = this.config.pjson.oclif.scope
    if (!scope) return
    return `@${scope}/plugin-${name}`
  }

  async maybeUnfriendlyName(name: string): Promise<string> {
    const unfriendly = this.unfriendlyName(name)
    if (unfriendly && await this.npmHasPackage(unfriendly)) {
      return unfriendly
    }
    return name
  }

  friendlyName(name: string): string {
    const scope = this.config.pjson.oclif.scope
    if (!scope) return name
    const match = name.match(`@${scope}/plugin-(.+)`)
    if (!match) return name
    return match[1]
  }

  // private async loadPlugin(plugin: Config.PJSON.PluginTypes) {
  //   return Config.load({...plugin as any, root: this.config.dataDir})
  // }

  private async createPJSON() {
    if (!fs.existsSync(this.pjsonPath)) {
      await this.savePJSON(initPJSON)
    }
  }

  private get pjsonPath() {
    return path.join(this.config.dataDir, 'package.json')
  }

  private get npmRegistry(): string {
    return this.config.npmRegistry || 'https://registry.npmjs.org'
  }

  private async npmHasPackage(name: string): Promise<boolean> {
    try {
      const http: typeof HTTP = require('http-call').HTTP
      let url = `${this.npmRegistry}/-/package/${name.replace('/', '%2f')}/dist-tags`
      await http.get(url)
      return true
    } catch (err) {
      this.debug(err)
      return false
    }
  }

  private async savePJSON(pjson: Config.PJSON.User) {
    pjson.oclif.plugins = this.normalizePlugins(pjson.oclif.plugins)
    const fs: typeof fse = require('fs-extra')
    await fs.outputJSON(this.pjsonPath, pjson, {spaces: 2})
  }

  private normalizePlugins(input: Config.PJSON.User['oclif']['plugins']) {
    let plugins = (input || []).map(p => {
      if (typeof p === 'string') {
        return {name: p, type: 'user', tag: 'latest'} as Config.PJSON.PluginTypes.User
      } else return p
    })
    plugins = uniqWith(plugins, (a, b) => a.name === b.name || (a.type === 'link' && b.type === 'link' && a.root === b.root))
    return plugins
  }
}
