// Jenkins Declarative Pipeline for the 3-tier e-commerce app.
//
// Agent prerequisites (install on the Jenkins agent, or use the
// `docker`/`kubectl`/`aws`/`terraform`/`trivy` labeled agents referenced
// below):
//   - Docker Engine (agent must be able to run `docker build`)
//   - Trivy CLI (https://aquasecurity.github.io/trivy)
//   - AWS CLI v2 + kubectl 1.29+
//   - Terraform 1.9+
//
// Jenkins plugins required: Pipeline, Git, Docker Pipeline, Credentials
// Binding, AWS Steps (or just AWS CLI on PATH), Slack Notification (optional).
//
// Credentials expected in Jenkins Credentials Store:
//   - "ecr-registry-url"      (Secret text)  e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com
//   - "aws-creds"             (AWS Credentials) used for ECR login / kubectl / terraform
//   - "kubeconfig"            (Secret file)  kubeconfig for the target EKS cluster

pipeline {
    agent any

    options {
        timestamps()
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20'))
        ansiColor('xterm')
    }

    parameters {
        booleanParam(name: 'DEPLOY_TO_K8S', defaultValue: true, description: 'Apply k8s manifests after a successful scan/push')
        booleanParam(name: 'RUN_TERRAFORM', defaultValue: false, description: 'Run terraform plan/apply for the target infra')
    }

    environment {
        AWS_REGION      = 'us-east-1'
        ECR_REGISTRY    = credentials('ecr-registry-url')
        IMAGE_TAG       = "${env.GIT_COMMIT ? env.GIT_COMMIT.take(7) : env.BUILD_NUMBER}"
        FRONTEND_IMAGE  = "${ECR_REGISTRY}/ecom-frontend:${IMAGE_TAG}"
        BACKEND_IMAGE   = "${ECR_REGISTRY}/ecom-backend:${IMAGE_TAG}"
        KUBE_NAMESPACE  = 'ecom'
    }

    stages {

        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Install & Test') {
            parallel {
                stage('Backend') {
                    steps {
                        dir('backend') {
                            sh 'npm ci'
                            sh 'npm test'
                        }
                    }
                }
                stage('Frontend') {
                    steps {
                        dir('frontend') {
                            sh 'npm ci'
                            sh 'npm test'
                            sh 'npm run build'
                        }
                    }
                }
            }
        }

        stage('Terraform (infra)') {
            when { expression { return params.RUN_TERRAFORM } }
            steps {
                dir('terraform') {
                    withCredentials([usernamePassword(credentialsId: 'aws-creds',
                                     usernameVariable: 'AWS_ACCESS_KEY_ID',
                                     passwordVariable: 'AWS_SECRET_ACCESS_KEY')]) {
                        sh 'terraform init -input=false'
                        sh 'terraform validate'
                        sh 'terraform plan -input=false -out=tfplan'
                        sh 'terraform apply -input=false -auto-approve tfplan'
                    }
                }
            }
        }

        stage('Build Docker Images') {
            parallel {
                stage('Backend image') {
                    steps {
                        sh "docker build -t ${BACKEND_IMAGE} -t ${ECR_REGISTRY}/ecom-backend:latest ./backend"
                    }
                }
                stage('Frontend image') {
                    steps {
                        sh "docker build -t ${FRONTEND_IMAGE} -t ${ECR_REGISTRY}/ecom-frontend:latest ./frontend"
                    }
                }
            }
        }

        stage('Trivy Image Scan') {
            steps {
                sh '''
                  trivy --version
                  mkdir -p trivy-reports
                '''
                script {
                    // Fail the build on HIGH/CRITICAL CVEs; still emit a
                    // human-readable + machine-readable (SARIF) report first
                    // so failures are diagnosable from build artifacts.
                    ['backend', 'frontend'].each { tier ->
                        def image = tier == 'backend' ? env.BACKEND_IMAGE : env.FRONTEND_IMAGE
                        sh """
                          trivy image --exit-code 0 --format table ${image} \
                            > trivy-reports/${tier}-report.txt
                          trivy image --exit-code 0 --format sarif ${image} \
                            > trivy-reports/${tier}-report.sarif
                          trivy image --config trivy/trivy.yaml --exit-code 1 ${image}
                        """
                    }
                }
            }
            post {
                always {
                    archiveArtifacts artifacts: 'trivy-reports/*', allowEmptyArchive: true
                }
            }
        }

        stage('Push to ECR') {
            steps {
                withCredentials([usernamePassword(credentialsId: 'aws-creds',
                                 usernameVariable: 'AWS_ACCESS_KEY_ID',
                                 passwordVariable: 'AWS_SECRET_ACCESS_KEY')]) {
                    sh '''
                      aws ecr get-login-password --region ${AWS_REGION} \
                        | docker login --username AWS --password-stdin ${ECR_REGISTRY}
                    '''
                    sh "docker push ${BACKEND_IMAGE}"
                    sh "docker push ${ECR_REGISTRY}/ecom-backend:latest"
                    sh "docker push ${FRONTEND_IMAGE}"
                    sh "docker push ${ECR_REGISTRY}/ecom-frontend:latest"
                }
            }
        }

        stage('Deploy to Kubernetes') {
            when { expression { return params.DEPLOY_TO_K8S } }
            steps {
                withCredentials([file(credentialsId: 'kubeconfig', variable: 'KUBECONFIG')]) {
                    sh '''
                      kubectl apply -f k8s/namespace.yaml
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/configmap.yaml
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/secret.yaml
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/mongo-statefulset.yaml
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/mongo-service.yaml
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/backend-deployment.yaml
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/backend-service.yaml
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/backend-hpa.yaml
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/frontend-deployment.yaml
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/frontend-service.yaml
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/ingress.yaml

                      kubectl set image deployment/backend backend=${BACKEND_IMAGE} -n ${KUBE_NAMESPACE}
                      kubectl set image deployment/frontend frontend=${FRONTEND_IMAGE} -n ${KUBE_NAMESPACE}

                      kubectl rollout status deployment/backend -n ${KUBE_NAMESPACE} --timeout=180s
                      kubectl rollout status deployment/frontend -n ${KUBE_NAMESPACE} --timeout=180s
                    '''
                }
            }
        }
    }

    post {
        success {
            echo "Build ${env.BUILD_NUMBER} succeeded: ${BACKEND_IMAGE}, ${FRONTEND_IMAGE}"
        }
        failure {
            echo "Build ${env.BUILD_NUMBER} failed — check the Trivy report artifacts and stage logs."
        }
        always {
            sh 'docker image prune -f || true'
        }
    }
}
