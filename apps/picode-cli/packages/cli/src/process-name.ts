export const CLI_COMMAND_NAME = "picode";
export const CLI_PROCESS_NAME = "picode-cli";

interface ProcessTitleTarget {
  title: string;
}

export const setCliProcessTitle = (
  target: ProcessTitleTarget = process,
): void => {
  target.title = CLI_PROCESS_NAME;
};
