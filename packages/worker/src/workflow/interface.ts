import { coresdk } from '@temporalio/proto';
import { WorkflowInfo } from '@temporalio/workflow';
import { ExternalCall } from '@temporalio/workflow/src/dependencies';

export interface Workflow {
  /**
   * Activate the Workflow.
   * TODO: document
   */
  activate(activation: coresdk.workflow_activation.IWFActivation): Promise<Uint8Array>;

  /**
   * Gets any external calls recorded during an activation.
   *
   * This is separate from `activate` so it can be called even if activation fails
   * in order to extract all logs and metrics from the Workflow context.
   */
  getAndResetExternalCalls(): Promise<ExternalCall[]>;

  /**
   * Dispose this instance, and release its resources.
   *
   * Do not use this Workflow instance after this method has been called.
   */
  dispose(): Promise<void>;
}

export interface WorkflowCreator {
  /**
   * Create a Workflow for the Worker to activate
   */
  createWorkflow(
    info: WorkflowInfo,
    interceptorModules: string[],
    randomnessSeed: number[],
    now: number
  ): Promise<Workflow>;

  /**
   * Destroy and cleanup any resources
   */
  destroy(): Promise<void>;
}
