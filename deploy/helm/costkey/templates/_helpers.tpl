{{- define "costkey.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}{{- end -}}
{{- end -}}

{{- define "costkey.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "costkey.secretName" -}}
{{- default (include "costkey.fullname" .) .Values.existingSecret -}}
{{- end -}}

{{- define "costkey.publicUrl" -}}
{{- if .Values.publicUrl -}}{{ .Values.publicUrl }}{{- else if .Values.ingress.enabled -}}{{ if .Values.ingress.tls }}https{{ else }}http{{ end }}://{{ .Values.ingress.host }}{{- else -}}http://localhost:4100{{- end -}}
{{- end -}}
