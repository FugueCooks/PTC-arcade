export function registerCabinetStatusPanel(registry){registry?.register?.('cabinet-status',{title:'Cabinet Status',render:state=>`${state.available||0} AVAILABLE`})}
