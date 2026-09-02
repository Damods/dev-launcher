# Dev Launcher 界面美化与优化规划

## 项目概述

**项目名称**: Dev Launcher  
**当前版本**: v1.11.1  
**技术栈**: Electron + 原生 JavaScript + CSS  
**当前设计风格**: 液态玻璃 (Liquid Glass) + 蓝白绿配色

---

## 一、设计目标

### 1.1 核心设计理念

打造一款**干净、优雅、现代化**的开发工具界面，具备以下特点：

- **视觉清晰度**: 减少视觉噪音，突出核心功能和信息层级
- **专业感**: 面向开发者的工具感，而非消费级应用的圆润可爱风格
- **高效操作**: 信息密度适中，快速扫描和操作友好
- **品质感**: 精致的细节处理和流畅的交互动效

### 1.2 设计方向

从当前的"液态玻璃 + 多彩渐变"风格，向**深色精简产品界面**演进：

**当前风格特征**:
- 大量使用 backdrop-filter 毛玻璃效果
- 蓝绿青多色渐变背景
- 较高的圆角半径 (18-30px)
- 明显的内阴影和高光效果

**目标风格特征**:
- 深色优先的专业工具界面
- 克制的配色：深海军蓝/石墨灰底 + 单一冷色调强调色
- 适度圆角 (8-16px)，保持产品感
- 减少装饰性效果，突出内容本身

---

## 二、配色方案重构

### 2.1 深色模式（主推荐）

**基础色板**:
```css
/* 背景层级 */
--page-bg: #0B0E14;           /* 最深层页面背景 */
--surface-1: #0F172A;         /* 主面板背景 */
--surface-2: #1E293B;         /* 次级面板/卡片 */
--surface-3: #334155;         /* 悬停/激活状态 */

/* 文字层级 */
--text-primary: #F8FAFC;      /* 主要文字 */
--text-secondary: #CBD5E1;    /* 次要文字 */
--text-muted: #64748B;        /* 辅助文字 */

/* 边框与分割线 */
--border-subtle: rgba(148, 163, 184, 0.1);
--border-default: rgba(148, 163, 184, 0.2);
--border-strong: rgba(148, 163, 184, 0.3);

/* 功能色 - 冷色调强调 */
--accent-primary: #38BDF8;    /* 天空蓝 - 主要操作 */
--accent-hover: #7DD3FC;      /* 悬停态 */
--accent-soft: rgba(56, 189, 248, 0.1);

/* 辅助色 */
--success: #10B981;           /* 运行中状态 */
--warning: #F59E0B;           /* 警告/配置需要 */
--danger: #EF4444;            /* 错误/停止 */
--info: #06B6D4;              /* 信息提示 */
```

### 2.2 浅色模式（可选）

**基础色板**:
```css
/* 背景层级 */
--page-bg: #F8FAFC;           /* 页面背景 */
--surface-1: #FFFFFF;         /* 主面板 */
--surface-2: #F1F5F9;         /* 次级面板 */
--surface-3: #E2E8F0;         /* 悬停态 */

/* 文字 */
--text-primary: #0F172A;
--text-secondary: #475569;
--text-muted: #94A3B8;

/* 边框 */
--border-subtle: rgba(15, 23, 42, 0.06);
--border-default: rgba(15, 23, 42, 0.12);
--border-strong: rgba(15, 23, 42, 0.18);

/* 功能色保持一致 */
--accent-primary: #0EA5E9;    /* 深色背景下更鲜艳的蓝 */
```

---

## 三、界面布局优化

### 3.1 窗口标题栏 (Titlebar)

**当前问题**:
- 毛玻璃效果过强，边界不清晰
- 主题切换按钮样式过于花哨

**优化方案**:
```
┌─────────────────────────────────────────────────┐
│ [图标] Dev Launcher        [主题] [-] [□] [×]   │  高度: 40px
└─────────────────────────────────────────────────┘
  背景: 纯色 surface-1 + 细线底边
  去除: backdrop-filter, 内阴影, 高光
```

**设计细节**:
- 背景改为纯色 `#0F172A`，不使用毛玻璃
- 底部边框: `1px solid var(--border-subtle)`
- 主题切换按钮: 扁平化，悬停时仅改变背景色
- 窗口控制按钮: 简化为纯图标 + 悬停变色

### 3.2 侧边栏 (Sidebar)

**当前问题**:
- 品牌区域占用空间过大
- 导航项目样式过于复杂（多层背景、阴影、高光）
- "运行中"卡片样式与整体不统一

**优化方案**:

**布局结构**:
```
┌─────────────────┐
│ [图标] Dev      │  品牌区 (紧凑化，高度 60px)
│       Launcher  │
├─────────────────┤
│ [icon] 全部项目  │  导航区
│ [icon] 启动组    │
│ ──────────────  │
│ [icon] 代码目录  │
│   └ 目录1       │
│   └ 目录2       │
│ ──────────────  │
│ [icon] 设置     │
├─────────────────┤
│ 运行中: 3       │  底部状态区
│ • 项目A         │
│ • 项目B         │
└─────────────────┘
  宽度: 240px
  背景: surface-1 纯色
  右侧细线边框分隔
```

**导航项样式简化**:
- 默认态: 透明背景 + 灰色文字
- 悬停态: `background: rgba(56, 189, 248, 0.08)` + 蓝色文字
- 激活态: `background: rgba(56, 189, 248, 0.15)` + 左侧 2px 蓝色边框
- 去除: 内阴影、高光、毛玻璃、复杂渐变

### 3.3 主工作区 (Workspace)

**顶部操作栏优化**:
```
┌────────────────────────────────────────────────┐
│ 全部项目                      [停止] [扫描] [+] │  高度: 68px
│ 集中启动和管理本地开发服务                      │
└────────────────────────────────────────────────┘
  背景: surface-1
  底部边框: 1px solid border-subtle
```

**工具栏简化**:
```
┌────────────────────────────────────────────────┐
│ [🔍 搜索框]            [类型▾] [状态▾]         │  高度: 56px
└────────────────────────────────────────────────┘
  去除毛玻璃，改为纯色背景
  搜索框: 简单边框 + 悬停态变化
```

**项目卡片重设计**:

当前卡片层级过多（文件夹 > 卡片容器 > 项目行），优化为**扁平化列表**:

```
┌────────────────────────────────────────────────┐
│ 📁 E:\code\backend (3 项目)                  [v]│
│ ┌──────────────────────────────────────────────┤
│ │ Maven  商城后端                         [▶️]  │
│ │ mvn spring-boot:run                          │
│ │ E:\code\backend\mall-service                 │
│ ├──────────────────────────────────────────────┤
│ │ 前端   商城前台                    ●运行中 [■] │
│ │ npm run dev                                  │
│ │ E:\code\backend\mall-web                     │
│ └──────────────────────────────────────────────┘
```

**卡片设计规范**:
- 外层文件夹: `background: surface-2`, 圆角 12px
- 项目行: `background: surface-1`, 底部细线分隔
- 悬停态: `background: rgba(255,255,255,0.03)`
- 去除: 复杂阴影、内高光、渐变色

---

## 四、组件样式重构

### 4.1 按钮系统

**主要按钮 (Primary)**:
```css
background: #38BDF8;
color: #0F172A;
border-radius: 8px;
padding: 8px 16px;
font-weight: 600;
/* 悬停: 提亮 10% */
/* 激活: scale(0.98) */
```

**次要按钮 (Secondary)**:
```css
background: transparent;
border: 1px solid var(--border-default);
color: var(--text-secondary);
/* 悬停: border-color 变亮, background 微亮 */
```

**危险按钮 (Danger)**:
```css
background: transparent;
border: 1px solid rgba(239, 68, 68, 0.3);
color: #EF4444;
/* 悬停: 背景填充淡红色 */
```

**图标按钮**:
```css
width: 36px;
height: 36px;
border-radius: 8px;
background: transparent;
/* 悬停: background: rgba(255,255,255,0.05) */
```

### 4.2 输入框 / 选择框

**统一样式**:
```css
height: 38px;
padding: 0 12px;
background: var(--surface-2);
border: 1px solid var(--border-default);
border-radius: 8px;
color: var(--text-primary);

/* 聚焦态 */
border-color: var(--accent-primary);
box-shadow: 0 0 0 3px var(--accent-soft);
```

### 4.3 状态标签 (Badge)

**简化设计**:
```css
.badge {
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 600;
}

.badge.running {
  background: rgba(16, 185, 129, 0.15);
  color: #10B981;
}

.badge.maven {
  background: rgba(56, 189, 248, 0.12);
  color: #38BDF8;
}
```

### 4.4 日志控制台

**终端主题优化**:
```css
background: #0B0E14;  /* 更深的背景 */
color: #CBD5E1;       /* 清晰的文字 */
font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
font-size: 12px;
line-height: 1.6;

/* URL 链接 */
.log-link {
  color: #38BDF8;
  text-decoration: underline;
}

/* 时间戳 */
.log-time {
  color: #64748B;
}

/* 错误日志 */
.log-line.stderr {
  color: #F87171;
}
```

---

## 五、动效与交互优化

### 5.1 过渡动画统一

**全局缓动函数**:
```css
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);     /* 标准退出 */
--ease-in-out: cubic-bezier(0.45, 0, 0.55, 1); /* 双向平滑 */

/* 统一时长 */
--duration-fast: 150ms;
--duration-normal: 250ms;
--duration-slow: 350ms;
```

**应用场景**:
- 按钮悬停/激活: 150ms
- 面板展开/收起: 250ms
- 模态框出现: 350ms

### 5.2 减少过度动效

**去除的效果**:
- ❌ 玻璃呼吸动画 (`@keyframes glass-breathe`)
- ❌ 主题切换时的旋转动画（过于花哨）
- ❌ 多层嵌套的 box-shadow 动画

**保留的效果**:
- ✅ 运行中状态点的呼吸动画（实用）
- ✅ 按钮激活的 scale 缩放（反馈感强）
- ✅ 列表项悬停的背景色渐变（必要）

### 5.3 性能优化

**减少合成层**:
- 去除不必要的 `backdrop-filter`（GPU 密集）
- 减少嵌套的 `::before` / `::after` 伪元素
- 动画仅使用 `transform` 和 `opacity`

---

## 六、圆角与间距规范

### 6.1 圆角系统（统一收紧）

```css
--radius-xs: 4px;   /* 小标签、分割线端点 */
--radius-sm: 6px;   /* 状态标签、小按钮 */
--radius-md: 8px;   /* 按钮、输入框、卡片 */
--radius-lg: 12px;  /* 大面板、文件夹卡片 */
--radius-xl: 16px;  /* 模态框、侧边栏 */
```

**对比当前**:
- 当前: 18px ~ 30px（过于圆润）
- 优化后: 8px ~ 16px（专业工具感）

### 6.2 间距系统

```css
--space-xs: 4px;
--space-sm: 8px;
--space-md: 12px;
--space-lg: 16px;
--space-xl: 24px;
--space-2xl: 32px;
```

**应用规则**:
- 卡片内边距: 16px
- 卡片间距: 12px
- 按钮组间距: 8px
- 区块间距: 24px

---

## 七、响应式与可访问性

### 7.1 响应式断点

保持现有断点，优化缩放表现:
```css
@media (max-width: 1180px) { /* 中屏 */ }
@media (max-width: 1060px) { /* 小屏 */ }
```

### 7.2 可访问性增强

**对比度检查**:
- 所有文字与背景对比度 ≥ 4.5:1 (WCAG AA)
- 重要操作（按钮）对比度 ≥ 7:1 (WCAG AAA)

**键盘导航**:
- 保留 `:focus-visible` 样式
- 增强焦点指示器清晰度

**减少动画**:
- 保留 `@media (prefers-reduced-motion)` 支持

---

## 八、实施计划

### Phase 1: 配色与变量重构 (2-3小时)
1. 更新 CSS 变量定义（`:root` 和 `[data-theme="dark"]`）
2. 统一圆角、间距、动效时长变量
3. 移除不需要的颜色变量（过多的渐变色）

### Phase 2: 布局简化 (3-4小时)
1. 标题栏去毛玻璃，改为纯色
2. 侧边栏品牌区紧凑化
3. 主工作区顶栏高度调整
4. 移除所有 `backdrop-filter`（除模态框外）

### Phase 3: 组件重构 (4-5小时)
1. 按钮系统标准化（primary/secondary/danger）
2. 项目卡片扁平化设计
3. 状态标签简化
4. 输入框统一样式

### Phase 4: 细节打磨 (2-3小时)
1. 日志控制台优化
2. 模态框样式调整
3. 过渡动画优化
4. 移除冗余代码

### Phase 5: 测试与调优 (1-2小时)
1. 深色/浅色模式切换测试
2. 窗口最大化/还原测试
3. 响应式布局检查
4. 性能测试（GPU 占用对比）

**总预估工时**: 12-17 小时

---

## 九、预期效果对比

### 视觉效果
| 维度 | 当前 | 优化后 |
|------|------|--------|
| 配色复杂度 | 蓝/绿/青三色渐变 | 单一天空蓝强调色 |
| 背景效果 | 大量毛玻璃 + 多层阴影 | 纯色分层 + 细线分隔 |
| 圆角风格 | 18-30px（消费级） | 8-16px（工具级） |
| 视觉噪音 | 较多装饰元素 | 干净简洁 |

### 性能表现
- **GPU 占用**: 预计降低 30-40%（减少 backdrop-filter）
- **渲染帧率**: 窗口调整时更流畅
- **内存占用**: 略微降低（简化 DOM 结构）

### 用户体验
- **信息扫描**: 更快速定位关键信息
- **操作效率**: 减少视觉干扰，专注核心功能
- **专业感**: 更符合开发工具的定位

---

## 十、风险与注意事项

### 10.1 兼容性风险
- **Windows 7/8**: 部分 CSS 变量可能不支持（已有 Electron 43 保障）
- **低性能机器**: 移除毛玻璃后反而更流畅（正面）

### 10.2 用户习惯
- **现有用户**: 可能需要适应新的视觉风格
- **建议**: 提供"经典主题"选项保留现有风格

### 10.3 实施注意
- **版本控制**: 创建 `feature/ui-redesign` 分支
- **截图留存**: 改造前后对比
- **逐步迭代**: 先完成深色模式，浅色模式可后续优化

---

## 十一、参考与灵感

### 设计参考
- **Visual Studio Code**: 深色侧边栏 + 扁平卡片
- **Linear**: 现代化项目管理界面
- **Raycast**: 命令面板设计
- **GitHub Desktop**: 简洁的工具界面

### 技术参考
- **Apple Human Interface Guidelines**: 间距与圆角系统
- **Material Design 3**: 色彩层级与状态设计
- **Tailwind CSS**: 功能色定义

---

## 附录：关键 CSS 代码示例

### A1. 新配色变量（深色模式）
```css
:root[data-theme="dark"] {
  /* 基础背景 */
  --page: #0B0E14;
  --surface-1: #0F172A;
  --surface-2: #1E293B;
  --surface-3: #334155;
  
  /* 文字 */
  --text: #F8FAFC;
  --muted: #CBD5E1;
  --muted-2: #64748B;
  
  /* 边框 */
  --line: rgba(148, 163, 184, 0.1);
  --line-strong: rgba(148, 163, 184, 0.2);
  
  /* 强调色 */
  --blue: #38BDF8;
  --blue-hover: #7DD3FC;
  --blue-soft: rgba(56, 189, 248, 0.1);
  
  /* 功能色 */
  --success: #10B981;
  --warning: #F59E0B;
  --danger: #EF4444;
  
  /* 圆角 */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  
  /* 阴影（简化） */
  --shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.1);
  --shadow-md: 0 4px 16px rgba(0, 0, 0, 0.15);
}
```

### A2. 简化按钮样式
```css
.button {
  height: 36px;
  padding: 0 16px;
  border-radius: var(--radius-md);
  font-size: 13px;
  font-weight: 600;
  transition: all 150ms cubic-bezier(0.16, 1, 0.3, 1);
}

.button.primary {
  background: var(--blue);
  color: var(--surface-1);
  border: none;
}

.button.primary:hover {
  background: var(--blue-hover);
  transform: translateY(-1px);
}

.button.primary:active {
  transform: scale(0.98);
}

.button.secondary {
  background: transparent;
  color: var(--text);
  border: 1px solid var(--line-strong);
}

.button.secondary:hover {
  background: var(--surface-3);
}
```

### A3. 扁平化项目卡片
```css
.project-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--surface-1);
  border-bottom: 1px solid var(--line);
  transition: background 150ms ease;
}

.project-card:hover {
  background: rgba(255, 255, 255, 0.03);
}

.project-card.selected {
  border-left: 2px solid var(--blue);
  background: var(--blue-soft);
}
```

---

## 结语

本次重构的核心目标是**化繁为简**，从视觉上回归开发工具的本质——**高效、专业、舒适**。通过统一配色、简化样式、优化性能，打造一款真正好用、耐看的本地开发启动器。

**预期成果**: 用户在使用时能够更快速地找到目标项目，更清晰地查看运行状态，更流畅地执行操作，而不会被过多的视觉装饰所分散注意力。

---

**文档版本**: v1.0  
**创建日期**: 2026-09-01  
**作者**: Dev Launcher Team
