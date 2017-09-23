/**
 *   Wechaty - https://github.com/chatie/wechaty
 *
 *   @copyright 2016-2017 Huan LI <zixia@zixia.net>
 *
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *   Unless required by applicable law or agreed to in writing, software
 *   distributed under the License is distributed on an "AS IS" BASIS,
 *   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *   See the License for the specific language governing permissions and
 *   limitations under the License.
 *
 */
import { EventEmitter } from 'events'
// v8.x only import { promisify }    from 'util'

const psTree            = require('ps-tree')
const retryPromise      = require('retry-promise').default // https://github.com/olalonde/retry-promise
import { StateSwitch }  from 'state-switch'

import {
  config,
  HeadName,
  log,
}                           from '../config'

import {
  BrowserCookie,
}                           from './browser-cookie'
import {
  BrowserDriver,
  IWebDriverOptionsCookie,
  By,
}                           from './browser-driver'

export interface BrowserSetting {
  head:         HeadName,
  sessionFile?: string,
}

export class Browser extends EventEmitter {

  private cookie: BrowserCookie
  public driver:  BrowserDriver

  public state = new StateSwitch<'open', 'close'>('Browser', 'close', log)

  constructor(
    private setting: BrowserSetting = {
      head: config.head,
      sessionFile: '',
    },
  ) {
    super()
    log.verbose('PuppetWebBrowser', 'constructor() with head(%s) sessionFile(%s)', setting.head, setting.sessionFile)

    this.driver = new BrowserDriver(this.setting.head)
    this.cookie = new BrowserCookie(this.driver, this.setting.sessionFile)
  }

  public toString() { return `Browser({head:${this.setting.head})` }

  public async init(): Promise<void> {
    log.verbose('PuppetWebBrowser', 'init()')

    /**
     * do not allow to init() twice without quit()
     */
    if (this.state.current() === 'open') {
      let e: Error
      if (this.state.inprocess()) {
        e = new Error('init() fail: current state is `open`-`ing`')
      } else {
        e = new Error('init() fail: current state is `open`')
      }
      log.error('PuppetWebBrowser', e.message)
      throw e
    }

    this.state.target('open')
    this.state.current('open', false)

    const hostname = this.cookie.hostname()

    // jumpUrl is used to open in browser for we can set cookies.
    // backup: 'https://res.wx.qq.com/zh_CN/htmledition/v2/images/icon/ico_loading28a2f7.gif'
    const jumpUrl = `https://${hostname}/zh_CN/htmledition/v2/images/webwxgeticon.jpg`

    try {
      await this.driver.init()
      log.verbose('PuppetWebBrowser', 'init() driver.init() done')

      await this.open(jumpUrl)
      await this.loadCookie()
                .catch(e => { // fail safe
                  log.verbose('PuppetWebBrowser', 'browser.loadSession(%s) exception: %s',
                                                  this.setting.sessionFile,
                                                  e && e.message || e,
                  )
                })
      await this.open()

      /**
       * when open url, there could happen a quit() call.
       * should check here: if we are in `close` target state, we should clean up
       */
      if (this.state.target() !== 'open') {
        throw new Error('init() open() done, but state.target() is set to close after that. has to quit().')
      }

      this.state.current('open')

      return

    } catch (err) {
      log.error('PuppetWebBrowser', 'init() exception: %s', err.message)

      await this.quit()

      throw err
    }
  }

  public async hostname(): Promise<string | null> {
    log.verbose('PuppetWebBrowser', 'hostname()')
    const domain = await this.execute('return location.hostname')
    log.silly('PuppetWebBrowser', 'hostname() got %s', domain)
    return domain
  }

  public async open(url?: string): Promise<void> {
    log.verbose('PuppetWebBrowser', 'open(%s)', url)

    if (!url) {
      const hostname = this.cookie.hostname()
      if (!hostname) {
        throw new Error('hostname unknown')
      }
      url = `https://${hostname}`
    }

    const openUrl = url

    // Issue #175
    // TODO: set a timer to guard driver.get timeout, then retry 3 times 201607
    const TIMEOUT = 60 * 1000
    let ttl = 3
    while (ttl--) {
      log.verbose('PuppetWebBrowser', 'open() begin for ttl:%d', ttl)
      try {
        await new Promise<void>(async (resolve, reject) => {

          const timer = setTimeout(_ => {
            const e = new Error('timeout after '
                                + Math.round(TIMEOUT / 1000) + ' seconds'
                                + 'at ttl:' + ttl,
                              )
            return reject(e)
          }, TIMEOUT)

          try {
            await this.driver.get(openUrl)
            // open successful!
            log.verbose('PuppetWebBrowser', 'open(%s) end at ttl:%d', openUrl, ttl)
            return resolve()

          } catch (e) {
            return reject(e)

          } finally {
            clearTimeout(timer)
          }
        })

        // open successful
        return

      } catch (e) {
        log.error('PuppetWebBrowser', 'open() exception: %s', e.message)

        await this.driver.close()
        await this.driver.quit()
        await this.driver.init()
        log.verbose('PuppetWebBrowser', 'open() driver.{close,quit,init}() done')
      }
    }

    await this.driver.close()
    await this.driver.quit()
    throw new Error('open fail because ttl expired')
  }

  public async refresh(): Promise<void> {
    log.verbose('PuppetWebBrowser', 'refresh()')
    await this.driver
              .navigate()
              .refresh()
    return
  }

  public async restart(): Promise<void> {
    log.verbose('PuppetWebBrowser', 'restart()')

    await this.quit()

    if (this.state.current() === 'open' && this.state.inprocess()) {
      log.warn('PuppetWebBrowser', 'restart() found state.current() === open and inprocess() after quit()!')
      return
    }

    await this.init()
  }

  public async quit(): Promise<void> {
    log.verbose('PuppetWebBrowser', 'quit()')

    if (this.state.current() === 'close') {
      let e: Error
      if (this.state.inprocess()) {
        e = new Error('quit() fail: on a browser with state.current():`close` and inprocess():`true` ?')
      } else { // stable
        e = new Error('quit() fail: on a already quit-ed browser')
      }
      log.warn('PuppetWebBrowser', e.message)
      throw e
    }

    this.state.target('close')
    this.state.current('close', false)

    try {
      await this.driver.close()
                      .catch(e => {   // http://stackoverflow.com/a/32341885/1123955
                        log.error('PuppetWebBriowser', 'quit() this.driver.close() exception %s', e.message)
                      })
      log.silly('PuppetWebBrowser', 'quit() driver.close() done')
      await this.driver.quit()
                      .catch( e => log.error('PuppetWebBrowser', 'quit() this.driver.quit() exception %s', e.message))
      log.silly('PuppetWebBrowser', 'quit() driver.quit() done')

      /**
       *
       * if we use AVA test runner, then this.clean might cause problems
       * because there will be more than one instance of browser with the same nodejs process id
       *
       */
      try {
        await this.clean()
      } catch (e) {
        await this.clean(true)
      }

    } catch (e) {
      // log.warn('PuppetWebBrowser', 'err: %s %s %s %s', e.code, e.errno, e.syscall, e.message)
      log.warn('PuppetWebBrowser', 'quit() exception: %s', e.message)

      const crashMsgs = [
        'ECONNREFUSED',
        'WebDriverError: .* not reachable',
        'NoSuchWindowError: no such window: target window already closed',
      ]
      const crashRegex = new RegExp(crashMsgs.join('|'), 'i')

      if (crashRegex.test(e.message)) { log.warn('PuppetWebBrowser', 'driver.quit() browser crashed') }
      else                            { log.warn('PuppetWebBrowser', 'driver.quit() exception: %s', e.message) }

      /* fail safe */

    } finally {
      this.state.current('close')
    }

    return
  }

  public async clean(kill = false): Promise<void> {
    log.verbose('PuppetWebBrowser', 'clean(kill=%s)', kill)

    const max = 15
    const backoff = 100

    /**
     * issue #86 to kill orphan browser process
     */
    if (kill) {
      const pidList = await this.getBrowserPidList()
      log.verbose('PuppetWebBrowser', 'clean() %d browsers will be killed', pidList.length)

      pidList.forEach(pid => {
        try {
          process.kill(pid, 'SIGKILL')
        } catch (e) {
          log.warn('PuppetWebBrowser', 'clean(kill=true) process.kill(%d, SIGKILL) exception: %s', pid, e.message)
        }
      })
    }

    /**
     * max = (2*totalTime/backoff) ^ (1/2)
     * timeout = 45000 for {max: 30, backoff: 100}
     * timeout = 11250 for {max: 15, backoff: 100}
     */
    const timeout = max * (backoff * max) / 2

    return retryPromise({max, backoff}, async attempt => {
      log.silly('PuppetWebBrowser', 'clean() retryPromise: attempt %s time for timeout %s',
                                    attempt,  timeout,
      )
      const pidList = await this.getBrowserPidList()
      if (pidList.length > 0) {
        throw new Error('browser number: ' + pidList.length)
      }
    })
  }

  public async getBrowserPidList(): Promise<number[]> {
    log.verbose('PuppetWebBrowser', 'getBrowserPidList()')

    const head = this.setting.head

    try {
      const children = await new Promise<any[]>((resolve, reject) => {
        psTree(process.pid, (err, c) => {
          if (err) {
            return reject(err)
          } else {
            return resolve(c)
          }
        })
      })

      let regexText: string

      switch (head) {
        case 'phantomjs':
          regexText = 'phantomjs'
          break

        case 'chrome':
        case 'chrome-headless':
          regexText = 'chrome(?!driver)|chromium'
          break

        default:
          const e = new Error('unsupported head: ' + head)
          log.warn('PuppetWebBrowser', 'getBrowserPids() for %s', e.message)
          throw e
      }

      const matchRegex = new RegExp(regexText, 'i')
      const pids: number[] = children.filter(child => {
        // https://github.com/indexzero/ps-tree/issues/18
        if (matchRegex.test('' + child.COMMAND + child.COMM)) {
          log.silly('PuppetWebBrowser', 'getBrowserPids() child: %s', JSON.stringify(child))
          return true
        }
        return false

      }).map(child => child.PID)

      return pids

    } catch (e) {
      log.error('PuppetWebBrowser', 'getBrowserPidList() exception: %s', e.message || e)
      throw e
    }
  }

  public async execute(script, ...args): Promise<any> {
    log.silly('PuppetWebBrowser', 'Browser.execute("%s")',
                                (
                                    script.slice(0, 80)
                                          .replace(/[\n\s]+/g, ' ')
                                    + (script.length > 80 ? ' ... ' : '')
                                ),
            )
    // log.verbose('PuppetWebBrowser', `Browser.execute() driver.getSession: %s`, util.inspect(this.driver.getSession()))
    if (this.dead()) {
      const e = new Error('Browser.execute() browser dead')
      log.warn('PuppetWebBrowser', 'execute() this.dead() %s', e.stack)
      throw e
    }

    let ret
    try {
      ret = await this.driver.executeScript.apply(this.driver, arguments)
    } catch (e) {
      // this.dead(e)
      log.warn('PuppetWebBrowser', 'execute() exception: %s, %s', e.message.substr(0, 99), e.stack)
      log.silly('PuppetWebBrowser', 'execute() script: %s', script)
      throw e
    }

    return ret
  }

  public async executeAsync(script, ...args): Promise<any> {
    log.silly('PuppetWebBrowser', 'Browser.executeAsync(%s)', script.slice(0, 80))
    if (this.dead()) { throw new Error('browser dead') }

    try {
      return await this.driver.executeAsyncScript.apply(this.driver, arguments)
    } catch (e) {
      // this.dead(e)
      log.warn('PuppetWebBrowser', 'executeAsync() exception: %s', e.message.slice(0, 99))
      throw e
    }
  }

  /**
   *
   * check whether browser is full functional
   *
   */
  public async readyLive(): Promise<boolean> {
    log.verbose('PuppetWebBrowser', 'readyLive()')

    if (this.dead()) {
      log.silly('PuppetWebBrowser', 'readyLive() dead() is true')
      return false
    }

    let two

    try {
      two = await this.execute('return 1+1')
    } catch (e) {
      two = e && e.message
    }

    if (two === 2) {
      return true // browser ok, living
    }

    const errMsg = 'found dead browser coz 1+1 = ' + two + ' (not 2)'
    log.warn('PuppetWebBrowser', 'readyLive() %s', errMsg)
    this.dead(errMsg)
    return false // browser not ok, dead
  }

  public dead(forceReason?: any): boolean {
    // too noisy!
    // log.silly('PuppetWebBrowser', 'dead() checking ... ')

    if ( this.state.target() === 'close'
      || this.state.current() === 'close'
      // || this.state.inprocess()
    ) {
      log.verbose('PuppetWebBrowser', 'dead() state target(%s) current(%s) stable(%s)',
                                      this.state.target(),
                                      this.state.current(),
                                      this.state.stable(),
      )
      log.verbose('PuppetWebBrowser', 'dead() browser is in dead state')
      return true
    }

    let msg
    let dead = false

    if (forceReason) {
      dead = true
      msg = forceReason
      log.verbose('PuppetWebBrowser', 'dead(forceReason=%s) %s', forceReason, new Error().stack)

    } else if (!this.driver) { // FIXME: this.driver is BrowserDriver, should add a method(sync) to check if availble 201610
      dead = true
      msg = 'no driver or session'
    }

    if (dead) {
      log.warn('PuppetWebBrowser', 'dead(%s) because %s',
                                   forceReason
                                    ? forceReason
                                    : '',
                                   msg,
      )

      if (   this.state.target()  === 'open'
          && this.state.current() === 'open'
          && this.state.stable()
      ) {
        log.verbose('PuppetWebBrowser', 'dead() emit a `dead` event because %s', msg)
        this.emit('dead', msg)
      } else {
        log.warn('PuppetWebBrowser', 'dead() wil not emit `dead` event because states are: target(%s), current(%s), stable(%s)',
                                     this.state.target(), this.state.current(), this.state.stable(),
        )
      }

    }
    return dead
  }

  public async clickSwitchAccount(): Promise<boolean> {
    log.verbose('PuppetWebBrowser', 'clickSwitchAccount()')

    try {
      const button = await this.driver.driver.findElement(By.xpath(
        "//div[contains(@class,'association') and contains(@class,'show')]/a[@ng-click='qrcodeLogin()']"))
      button.click()
      log.silly('PuppetWebBrowser', 'clickSwitchAccount() clicked!')
      return true
    } catch (e) {
      log.silly('PuppetWebBrowser', 'clickSwitchAccount() button not found')
      return false
    }
  }

  public addCookie(cookies: IWebDriverOptionsCookie[]):  Promise<void>
  public addCookie(cookie:  IWebDriverOptionsCookie):    Promise<void>

  public addCookie(cookie:  IWebDriverOptionsCookie | IWebDriverOptionsCookie[]): Promise<void> {
    return this.cookie.add(cookie)
  }

  public saveCookie()   { return this.cookie.save()   }
  public loadCookie()   { return this.cookie.load()   }
  public readCookie()   { return this.cookie.read()   }
  public cleanCookie()  { return this.cookie.clean()  }
}

export {
  IWebDriverOptionsCookie,
}

export default Browser
