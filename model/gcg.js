import base from "./base.js";
import MysInfo from './mys/mysInfo.js'
import lodash from 'lodash'

export default class Gcg extends base {
  constructor(e) {
    super(e);
    this.model = "gcg";

    //redis key 用于对比两次查询间的结果
    this.cacheKey = {
      winRateCacheKey: "gcg:winRate",
      totalRoundCacheKey: "gcg:totalRound",
      avatarCardResultCacheKey: "gcg:avatarCardResult"
    }

    //随机小提示
    this.tips = [
      "胜率统计基于米游社熟练度和使用次数，如有疑问请向原神客服反馈",
      "热知识：部分模式胜利后不会增加熟练度，只会增加使用次数",
      "冷知识：3.7 活动如果用尚未获取到的角色卡对战，熟练度和使用次数不会保存，直接虚空消失。会导致统计到的游戏总局数偏少。",
      "冷知识：如急着更新数据请小退原神（即返回开门的界面)，再次进门，可加快数据更新速度",
      "冷知识：3.5版本风花节活动和赛诺对战后只会增加熟练度不会增加使用次数，因此会出现1熟练度0使用度，或者胜率大于100%的奇观",
      "冷知识：游戏最重要的不是胜率，而是快乐。",
      "小知识：如果查询七圣数据时数据变化，会发送变化的数据，如果数据未变化，会发送全卡牌一图流数据",
    ];
  }

  async getRandomTip() {
    return lodash.sample(this.tips);
  }

  async getData() {
    let res = {}

    //由于数据处理需要时间，先回复一条消息告诉用户正在处理
    await this.e.reply(`正在获取数据，请稍后...\n${await this.getRandomTip()}`, true, {recallMsg: 60});

    //从米游社接口获取数据
    for (let api of ['basicInfo', 'avatar_cardList', 'action_cardList']) {
      res[api] = (await MysInfo.get(this.e, api)).data
    }

    //获取当前用户uid
    const uid = this.e.uid

    //如果结果为空，可能是验证码错误，直接返回
    if (!res['basicInfo'] || !res['avatar_cardList'] || !res['action_cardList']) {
      return false;
    }

    //未获得任何角色卡牌，返回false
    if (res['basicInfo'].avatar_card_num_gained === 0) {
      await this.e.reply("您还没有获得任何卡牌，无法查询。", true, {recallMsg: 60});
      return false;
    }

    //用于渲染及上传数据
    let gcgData = {
      uid: uid,
    };

    //读取gcgBasicInfo 获取等级和卡牌数量
    gcgData.level = res['basicInfo'].level; //牌手等级
    gcgData.nickname = res['basicInfo'].nickname; //牌手昵称
    gcgData.avatar_card_num_gained = res['basicInfo'].avatar_card_num_gained; //角色卡牌数量
    gcgData.avatar_card_num_total = res['basicInfo'].avatar_card_num_total; //全角色卡牌数量
    gcgData.action_card_num_gained = res['basicInfo'].action_card_num_gained; //行动卡牌数量
    gcgData.action_card_num_total = res['basicInfo'].action_card_num_total; //全行动卡牌数量

    //如果角色卡牌数据为空，返回false
    if (!res['avatar_cardList'].card_list || res['avatar_cardList'].card_list.length === 0) {
      this.e.reply("卡牌数据为空", true);
      return false;
    }

    //处理对局数据
    //处理角色牌数据
    //处理行动牌数据
    const [replayList, avatarCardResults, actionCardResult] =
      await Promise.all([
        this.getReplayData(res['basicInfo']?.replays),
        this.getAvatarData(res['avatar_cardList'].card_list),
        this.getActionData(res['action_cardList'].card_list)
      ])
    const {totalRound, totalWinRound, avatarCardResult} = avatarCardResults;
    gcgData.total_round = totalRound;
    gcgData.total_win_round = totalWinRound;
    gcgData.avatar_card_list = avatarCardResult;
    gcgData.action_card_list = actionCardResult;

    //处理胜率
    gcgData.win_rate = (totalWinRound === 0 ? 0 : (totalWinRound / totalRound * 100));

    //获取上一次查询结果
    const oldWinRate = await redis.get(`${this.cacheKey.winRateCacheKey}:${this.e.uid}`);
    const oldTotalRound = await redis.get(`${this.cacheKey.totalRoundCacheKey}:${this.e.uid}`);
    const winRateChange = gcgData.win_rate - oldWinRate;
    const totalRoundChange = gcgData.total_round - oldTotalRound;

    //将本次查询的数据存入redis
    await redis.set(`${this.cacheKey.winRateCacheKey}:${this.e.uid}`, gcgData.win_rate);
    await redis.set(`${this.cacheKey.totalRoundCacheKey}:${this.e.uid}`, gcgData.total_round);

    //===开始处理回复文本和图片===
    let msg = [];
    msg.push("⭐️");

    //显示UID和昵称
    msg.push(`\nUID：${uid}，昵称：${res['basicInfo'].nickname}`);
    msg.push(`\n总局数：${totalRound.toFixed(0)}，胜率：${gcgData.win_rate.toFixed(3)}%`);

    //显示对局数和胜率变化
    msg.push(`\n距上次查询对局+${totalRoundChange}，胜率${winRateChange.toString().includes("-") ? "" : "+"}${winRateChange.toFixed(3)}%`);

    //显示最近对局
    msg.push(`\n--------`);
    for (let i = 0; i < replayList.length; i++) {
      msg.push(`\n${replayList[i].match_type} ${replayList[i].oppositeName} ${replayList[i].is_win ? "胜利" : "失败"}`);
    }

    //比较新旧角色卡牌数据的熟练度和使用次数变化
    const changedData = await this.compareAvatarDataChanges(avatarCardResult);

    //将本次查询的数据存入redis，仅保存30天，以避免时隔太久再回来查询时数据变化太大
    await redis.setEx(`${this.cacheKey.avatarCardResultCacheKey}:${this.e.uid}`, 3600 * 24 * 30, JSON.stringify(avatarCardResult));

    if (changedData.length > 0) {
      //如果有变化的数据，机器人只发送变动数据，不生成图片
      msg.push("\n");
      for (let val in changedData) {
        let text = "";
        const lostCount = changedData[val].use_count_change - changedData[val].proficiency_change;
        if (changedData[val].isNew) {
          text += '[新]'
        }

        text += `${changedData[val].card_name}: ${changedData[val].proficiency_change}胜 ${lostCount}负 熟练度${changedData[val].proficiency}`;

        //最后一行不加换行
        if (val !== changedData.length - 1) {
          text += "\n";
        }

        msg.push(text);
      }

      await this.e.reply(msg.join(""), true);
      return false;
    }

    msg.push("\n图片生成中，请稍后...");

    msg = msg.join("");
    await this.e.reply(msg, true);

    let baseRenderData = {
      ...this.screenData,
      uid: this.e.uid,
      saveId: this.e.uid,
      gcgData,
    }

    const avatarRenderData = {
      ...baseRenderData,
      quality: 100,
      omitBackground: true,
      renderType: "avatar",
    }

    const actionRenderData = {
      ...baseRenderData,
      quality: 100,
      omitBackground: true,
      renderType: "action",
    }
    return {avatarRenderData, actionRenderData}
  }

  /**
   * 处理接口返回的角色卡牌数据
   * @param avatarCardList
   * @return {Promise<{avatarCardResult: *, totalRound: number, totalWinRound: number}>}
   */
  async getAvatarData(avatarCardList) {
    let totalWinRound = 0;
    let totalRound = 0;

    let result = avatarCardList
      .filter(card => {
        //处理3.5版本风花节活动引入的游戏bug
        //当玩家和赛诺对战获胜后，使用过的角色卡牌熟练度会+1，但是使用次数不变，行动牌使用次数也不变
        //如果玩家使用的是一张熟练度0使用次数0的角色卡对战，会导致最后该卡的熟练度为1，使用次数为0
        //计算单卡胜率的时候会出现除数为0的情况
        if (card.proficiency > card.use_count) {
          card.use_count = card.proficiency;
        }

        //如果使用次数为0，不显示
        if (card.use_count === 0) {
          return false;
        }

        totalWinRound += card.proficiency;
        totalRound += card.use_count;

        return true;
      })
      .map(card => {
        return {
          card_id: card.id,
          card_name: card.name,
          use_count: card.use_count,
          proficiency: card.proficiency,
          card_num: card.num,
          win_rate: (card.proficiency / card.use_count * 100).toFixed(3),
        };
      });

    //由于某些版本活动允许玩家使用未拥有的卡牌进行游戏
    //使得这些卡牌的使用次数和熟练度丢失，导致计算出的局数可能不能被3整除
    //因此这里向上取整处理
    totalRound = Math.ceil(totalRound / 3);
    totalWinRound = Math.ceil(totalWinRound / 3);

    //计算使用率
    result = result.map(card => {
      const usage_rate = ((card.use_count / totalRound) * 100).toFixed(3);
      return {...card, usage_rate}
    });

    //按熟练度排序
    result = lodash.sortBy(result, (o) => {
      return -o.proficiency;
    });

    logger.mark(`totalRound: ${totalRound}, totalWinRound: ${totalWinRound}`)

    return {
      totalRound,
      totalWinRound,
      avatarCardResult: result,
    }
  }

  /**
   * 处理接口返回的行动卡牌数据
   * @param actionCardList
   * @return {Promise<*>}
   */
  async getActionData(actionCardList) {
    let totalUsage = 0;

    let result = actionCardList
      .filter(card => {
        //如果使用次数为0，不显示
        totalUsage += card.use_count;
        return card.use_count !== 0;
      })
      .map(card => {
        const card_type = this.getActionCardType(card.card_type);
        return {
          card_id: card.id,
          card_name: card.name,
          card_type: card_type,
          use_count: card.use_count,
          card_num: card.num,
        };
      });

    //计算使用率
    result = result.map(card => {
      const usage_rate = ((card.use_count / totalUsage) * 100).toFixed(3);
      return {...card, usage_rate}
    });

    //按使用次数排序
    result = lodash.sortBy(result, (o) => {
      return -o.use_count;
    });

    return result;
  }

  /**
   * 比较新旧角色卡牌数据的熟练度和使用次数变化
   * @param avatarCardResult
   * @return {Promise<*>}
   */
  async compareAvatarDataChanges(avatarCardResult) {
    //获取上一次查询的数据
    const oldAvatarCardResult = await redis.get(`${this.cacheKey.avatarCardResultCacheKey}:${this.e.uid}`);
    if (!oldAvatarCardResult) {
      console.log("没有上一次查询的数据，跳过比较")
      return false;
    }

    const oldAvatarCardResultObj = JSON.parse(oldAvatarCardResult);

    //比较新旧数据的熟练度和使用次数变化
    let changedData = [];

    //校验新数据数量是否比旧数据少
    if (avatarCardResult.length < oldAvatarCardResultObj.length) {
      //正常情况新数据卡牌数量只可能和旧卡牌数量一致或变多
      //如果变少，说明米游社接口可能出了问题，比如接口数据强制分页
      //因为可能影响到后续查询、数据上传流程等，这里直接抛出异常
      logger.error(`检测到bug，本次查询角色卡牌数量 ${avatarCardResult.length} 少于上次查询角色卡牌数量 ${oldAvatarCardResultObj.length}，可能是米游社接口有改动，请反馈此问题并等待插件更新`);
      this.e.reply(`数据异常，请联系管理员处理`, true);
      throw new Error("数据异常，请联系管理员处理");
    }

    for (let val of avatarCardResult) {
      const oldCard = oldAvatarCardResultObj.find(card => card.card_id === val.card_id);
      if (!oldCard) {
        //如果旧数据中不存在该卡牌，说明是新卡牌
        changedData.push({
          card_name: val.card_name,
          use_count_change: val.use_count,
          proficiency_change: val.proficiency,
          proficiency: val.proficiency,
          isNew: true,
        });
        continue;
      }
      const oldProf = oldCard.proficiency;
      const newProf = val.proficiency;
      const oldUsage = oldCard.use_count;
      const newUsage = val.use_count;

      //理论上来说要检查新数据的值是否比旧数据小，但是我懒得写了
      if (oldProf !== newProf || oldUsage !== newUsage) {
        changedData.push({
          card_name: val.card_name,
          use_count_change: newUsage - oldUsage,
          proficiency_change: newProf - oldProf,
          proficiency: val.proficiency,
          isNew: false,
        });
      }
    }

    //排序，熟练度变动多的在前
    changedData = lodash.sortBy(changedData, (o) => {
      return -o.proficiency_change;
    });

    return changedData;
  }

  /**
   * 根据接口返回的 card_type 获取行动牌类型
   * @param card_type
   * @return {string}
   */
  getActionCardType(card_type) {
    switch (card_type) {
      case "CardTypeModify":
        return "装备牌";
      case "CardTypeAssist":
        return "支援牌";
      case "CardTypeEvent":
        return "事件牌";
      default:
        return "未知";
    }
  }

  /**
   * 从 GcgBasicInfo 里获取最近2场对局信息
   * @param replays
   * @return {Promise<void>}
   */
  async getReplayData(replays) {
    let replayList = [];
    try {
      //用于卡组胜率测试

      for (let i = 0; i < replays.length; i++) {
        const replay = replays[i];
        const game_id = replay.game_id;
        const matchType = replay.match_type;
        const isWin = replay.is_win;
        const selfOverflow = replay.self.is_overflow;
        const oppositeOverflow = replay.opposite.is_overflow;
        const oppositeName = replay.opposite.name;

        replayList.push({
          game_id: game_id,
          match_type: matchType,
          is_win: isWin,
          oppositeName: oppositeName,
          selfOverflow: selfOverflow,
          oppositeOverflow: oppositeOverflow,
        });
      }
    } catch (err) {
      logger.error("获取对局数据错误", err);
    }

    return replayList;
  }
}
