# 修复窗口关闭后无法从托盘唤醒的问题

## 问题描述

当用户点击关闭按钮后，软件会自动到后台工作，但再次点击托盘图标时无法唤醒窗口，必须在任务管理器中关闭进程才能重新打开。

## 根本原因

**核心问题**：窗口关闭逻辑设计不当，导致应用进入"半死"状态。

### 原始代码逻辑（存在缺陷）

在 `src/main/main.js:129-149` 的 `close` 事件处理中：

1. 当没有运行项目时，代码执行：
   ```javascript
   isQuitting = true;
   app.quit();
   ```

2. 但是 `main.js:312` 注册了空的 `window-all-closed` 监听器，阻止了默认退出行为：
   ```javascript
   app.on('window-all-closed', () => {});
   ```

3. 结果：
   - 窗口被销毁（`BrowserWindow` 对象变为 destroyed 状态）
   - `isQuitting` 标志被设置为 `true`
   - 应用进程继续运行（因为 `window-all-closed` 被拦截）
   - 托盘图标仍然存在

4. 当用户点击托盘图标尝试唤醒时：
   - `showWindow` 函数被调用（`main.js:298`）
   - `utils.js:83` 检查到 `isQuitting === true`，直接 `return`，不执行任何操作
   - 用户看不到任何反应

## 修复方案

将"关闭窗口"的行为从"退出应用"改为"隐藏到托盘"。

### 修改内容

**文件**：`src/main/main.js:129-149`

**修改前**：
```javascript
if (shouldQuitOnWindowClose(runningCount)) {
  // 无运行项目，直接退出主进程——避免 NSIS 升级检测到 Dev Launcher.exe 存活而阻断升级。
  isQuitting = true;
  app.quit();
  return;
}
```

**修改后**：
```javascript
if (shouldQuitOnWindowClose(runningCount)) {
  // 无运行项目：隐藏窗口到托盘，避免用户误以为软件已退出。
  mainWindow.hide();
  // 首次隐藏到托盘时显示提示，告知用户软件仍在后台运行。
  if (!trayNoticeShown) {
    trayNoticeShown = true;
    tray.displayBalloon({
      title: 'Dev Launcher',
      content: '已最小化到系统托盘，点击托盘图标可重新打开',
      icon: nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'icon-32.png'))
    });
  }
  return;
}
```

## 修复效果

1. **点击关闭按钮**：窗口隐藏到托盘，应用继续运行
2. **点击托盘图标**：窗口正常唤醒并显示
3. **首次隐藏到托盘**：弹出气泡提示，告知用户软件仍在后台运行
4. **真正退出**：通过托盘菜单的"退出"选项或应用内的退出功能

## 用户体验改进

- ✅ 关闭按钮变为最小化到托盘，符合常见工具软件的交互习惯
- ✅ 托盘图标可正常唤醒窗口，无需手动结束进程
- ✅ 气泡提示引导用户了解托盘功能
- ✅ 真正退出需要明确操作，避免误关闭

## 相关代码文件

- `src/main/main.js` - 主进程窗口管理逻辑
- `src/main/utils.js` - `showWindow` 工厂函数，处理窗口显示逻辑

## 测试建议

1. 启动应用，点击关闭按钮，验证窗口隐藏到托盘
2. 点击托盘图标，验证窗口正常唤醒
3. 首次隐藏时，验证是否显示气泡提示
4. 通过托盘菜单"退出"，验证应用正常退出
5. 运行项目时点击关闭，验证弹出警告对话框
