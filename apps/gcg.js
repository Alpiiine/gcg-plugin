import plugin from '../../../lib/plugins/plugin.js'
import Gcg from '../model/gcg.js'
import gsCfg from '../model/gsCfg.js'
import puppeteer from '../../../lib/puppeteer/puppeteer.js'

gsCfg.cpCfg('mys', 'set')

export class gcg extends plugin {
  constructor() {
    super({
      name: '七圣召唤查询',
      dsc: '七圣召唤查询',
      event: 'message',
      priority: 300,
      rule: [{
        reg: '^#(七圣战绩|七圣召唤战绩)$', //似乎有其他插件已经使用了七圣关键词，所以这里改成了#七圣战绩
        fnc: 'gcg'
      }]
    })

    this.set = gsCfg.getConfig('mys', 'set')
  }

  async gcg() {
    const gcg = new Gcg(this.e);
    let data = await gcg.getData();
    if (!data) return

    /** 生成图片 */
    let avatarImg = await puppeteer.screenshot(`gcg`, data.avatarRenderData)
    let actionImg = await puppeteer.screenshot(`gcg`, data.actionRenderData)
    if (avatarImg && actionImg) await this.reply([avatarImg, actionImg])
  }


}
