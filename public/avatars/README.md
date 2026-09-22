# 自定义头像

把图片放在本目录，然后在 `config.js` 的用户或 AI 配置里填文件名即可，例如：

```js
{ username: '小明', password: '123456', avatar: 'tom.png' }
```

```js
ai: { avatar: 'bot.png' }
```

支持 `png` / `jpg` / `jpeg` / `gif` / `webp` / `svg`，也支持直接填 emoji。
