import vm from 'vm';
import { AsyncLocalStorage } from 'async_hooks';
import { coresdk } from '@temporalio/proto';
import * as internals from '@temporalio/workflow/lib/worker-interface';
import { ExternalDependencyFunction, WorkflowInfo } from '@temporalio/workflow';
import { IllegalStateError } from '@temporalio/common';
import { partition } from '../utils';
import { Workflow, WorkflowCreator } from './interface';
import { ExternalCall } from '@temporalio/workflow/src/dependencies';

/**
 * Maintains a pool of v8 isolates, returns Context in a round-robin manner.
 * Pre-compiles the bundled Workflow code from provided {@link WorkflowIsolateBuilder}.
 */
export class VMWorkflowCreator implements WorkflowCreator {
  script: vm.Script | undefined;

  protected constructor(script: vm.Script, public readonly isolateExecutionTimeoutMs: number) {
    this.script = script;
  }

  async createWorkflow(
    info: WorkflowInfo,
    interceptorModules: string[],
    randomnessSeed: number[],
    now: number
  ): Promise<Workflow> {
    const context = await this.getContext();
    const { isolateExecutionTimeoutMs } = this;
    const workflowModule: WorkflowModule = new Proxy(
      {},
      {
        get(_: any, fn: string) {
          return (...args: any[]) => {
            context.args = args;
            return vm.runInContext(`lib.${fn}(...globalThis.args)`, context, {
              timeout: isolateExecutionTimeoutMs,
              displayErrors: true,
            });
          };
        },
      }
    ) as any;

    await workflowModule.initRuntime(info, interceptorModules, randomnessSeed, now);

    return new VMWorkflow(info, context, workflowModule, isolateExecutionTimeoutMs);
  }

  protected async getContext(): Promise<vm.Context> {
    if (this.script === undefined) {
      throw new IllegalStateError('Isolate context provider was destroyed');
    }
    const context = vm.createContext({ require });
    this.script.runInContext(context);
    return context;
  }

  /**
   * Create a new instance, isolates and pre-compiled scripts are generated here
   */
  public static async create(code: string, isolateExecutionTimeoutMs: number): Promise<VMWorkflowCreator> {
    const script = new vm.Script(code, { filename: 'workflow-isolate' });
    return new this(script, isolateExecutionTimeoutMs);
  }

  public async destroy(): Promise<void> {
    delete this.script;
  }
}

type WorkflowModule = typeof internals;

export class VMWorkflow implements Workflow {
  constructor(
    public readonly info: WorkflowInfo,
    protected context: vm.Context | undefined,
    readonly workflowModule: WorkflowModule,
    public readonly isolateExecutionTimeoutMs: number,
    readonly dependencies: Record<string, Record<string, ExternalDependencyFunction>> = {}
  ) {}

  async getAndResetExternalCalls(): Promise<ExternalCall[]> {
    return this.workflowModule.getAndResetExternalCalls();
  }

  /**
   * Inject a function into the isolate context global scope
   *
   * @param path name of global variable to inject the function as (e.g. `console.log`)
   * @param fn function to inject into the isolate
   */
  public async injectGlobal(key: string, val: unknown): Promise<void> {
    if (this.context === undefined) {
      throw new IllegalStateError('Workflow isolate context uninitialized');
    }
    this.context[key] = val;
  }

  public async activate(activation: coresdk.workflow_activation.IWFActivation): Promise<Uint8Array> {
    if (this.context === undefined) {
      throw new IllegalStateError('Workflow isolate context uninitialized');
    }
    this.info.isReplaying = activation.isReplaying ?? false;
    if (!activation.jobs) {
      throw new Error('Expected workflow activation jobs to be defined');
    }

    // Job processing order
    // 1. patch notifications
    // 2. signals
    // 3. anything left except for queries
    // 4. queries
    const [patches, nonPatches] = partition(activation.jobs, ({ notifyHasPatch }) => notifyHasPatch !== undefined);
    const [signals, nonSignals] = partition(nonPatches, ({ signalWorkflow }) => signalWorkflow !== undefined);
    const [queries, rest] = partition(nonSignals, ({ queryWorkflow }) => queryWorkflow !== undefined);
    let batchIndex = 0;

    // Loop and invoke each batch and wait for microtasks to complete.
    // This is done outside of the isolate because when we used isolated-vm we couldn't wait for microtasks from inside the isolate, not relevant anymore.
    for (const jobs of [patches, signals, rest, queries]) {
      if (jobs.length === 0) {
        continue;
      }
      const arr = coresdk.workflow_activation.WFActivation.encodeDelimited({ ...activation, jobs }).finish();
      const { numBlockedConditions } = await this.workflowModule.activate(arr, batchIndex++);
      if (numBlockedConditions > 0) {
        await this.tryUnblockConditions();
      }
      // Wait for microtasks to be processed
      await new Promise((resolve) => process.nextTick(resolve));
    }
    return this.workflowModule.concludeActivation();
  }

  protected async tryUnblockConditions(): Promise<void> {
    for (;;) {
      const numUnblocked = this.workflowModule.tryUnblockConditions();
      if (numUnblocked === 0) break;
      await new Promise((resolve) => process.nextTick(resolve));
    }
  }

  /**
   * Dispose of the isolate's context.
   * Do not use this Workflow instance after this method has been called.
   */
  public async dispose(): Promise<void> {
    delete this.context;
  }
}
