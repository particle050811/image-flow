import { vscode, type WebviewTask } from './vscode';

/** 任务页：按时间倒序展示历史任务，缩略图较大，点击打开原图 */
export function Tasks({ hidden, tasks }: { hidden: boolean; tasks: WebviewTask[] }) {
	return (
		<div className="page" data-page="tasks" hidden={hidden}>
			{tasks.length === 0 ? (
				<div className="empty">暂无生成记录。</div>
			) : (
				tasks.map((task) => (
					<div className="task" key={task.folder}>
						<div className="folder">
							{task.folder}（{task.images.length} 张）
						</div>
						<div className="thumbs thumbs-lg">
							{task.images.map((img) => (
								<img
									key={img.uri}
									src={img.src}
									title={img.name}
									onClick={() => vscode.postMessage({ type: 'openImage', uri: img.uri })}
								/>
							))}
						</div>
					</div>
				))
			)}
		</div>
	);
}
